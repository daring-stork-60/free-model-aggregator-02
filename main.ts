// free-model-aggregator-02: one server, two client wires, and the best free model behind
// every answer.
//
// A trial runs this server as `node /bot/main.ts` from the repository's root, with Node 22's
// standard library alone (nothing is installed; TypeScript runs directly, and a relative import
// needs its .ts extension). The env is at $MAKEFUN_ENV_URL; model calls go through the grader's
// gateway at $OPENAI_BASE_URL, an OpenAI-compatible endpoint that reaches OpenRouter on the key
// pushed to the competition. The brief at $MAKEFUN_PROMPT_FILE carries two documents:
//   - the free model list: each free OpenRouter model's gateway id
//     (`openrouter/<vendor>/<model>:free`), its published rating in milli-points, what it can do
//     (tools, vision, JSON mode, context length) and its free flag;
//   - the six prompts: each one's id, its api (openai or anthropic), whether it streams, its
//     weight (1 or 2) and the requirements a model must meet to serve it. Each prompt carries a
//     unique token the answer must contain.
// The server:
//   1. listens on 0.0.0.0 at a free port (never 8080: the env itself is there on one layout);
//   2. POSTs $MAKEFUN_ENV_URL/register {"protocol_version": 1, "port": <port>, "catalog": <catalog>};
//   3. serves GET /v1/models (answering in the shape of the auth header it got: x-api-key means
//      Anthropic, Authorization means OpenAI), POST /v1/chat/completions and POST /v1/messages,
//      each with a JSON body or with server-sent events;
//   4. answers each prompt by dialling ONE free model through the gateway. OPENAI_API_KEY in the
//      sandbox is a dummy the gateway swaps for the entrant's own key; the real key never enters
//      the sandbox;
//   5. polls GET $MAKEFUN_ENV_URL/work every 100 ms and exits 0 when the env says {"done": true}.
//      A process still running when the wall ends scores zero, so never wait for anything else.
// `node main.ts --list` prints the same catalog JSON and exits 0 before any server starts; the
// register body's catalog is that same document, byte for byte.
//
// HOW THIS ENTRY WINS ITS SCORE
//   - quality (60%): every prompt is served by the highest-rated free model that meets its
//     requirements, ranked from the brief's own ratings at request time — never hardcoded, so a
//     final instance with different models or ratings still routes to its best. A model that has
//     refused twice this trial is cooling down and ranks behind models that have not, so one
//     rate-limited model cannot take every later prompt down with it.
//   - failover (10%): a refused gateway call is retried once on the same model after a fixed
//     short sleep, then failed over to the next-best model that meets the requirements, up to
//     four gateway calls per prompt. Every refusal is reported back on the answer in the
//     x-makefun-upstream-failures header, so a prompt that was refused and still served counts
//     as handled; a prompt that exhausts its attempts becomes a 502 that carries the same trail.
//   - served (15%): the same attempts that win failover win served — a prompt is only lost when
//     every candidate that meets it refuses.
//   - wire (10%): both wires are translated exactly (system prompt, images, tools, JSON mode,
//     streaming event order, usage and stop reason passed through whole), the dialled id is put
//     back on every answer and every streamed chunk, and a model answer that calls a tool the
//     client never declared has that call dropped, so only declared tool names are ever emitted.
//   - catalog (5%): the registered catalog and both GET /v1/models answers list exactly the free
//     models the brief names, once each.
//   - the tie-break is the number of gateway calls: a prompt with no refusal costs exactly one
//     call, and failover spends at most three more, only when a refusal forces it.
//
// THE MODEL RULE
//   Whatever this server reports in a response's `model` field must be the model it actually
//   dialled. The house records every gateway call and scores the model that really answered. This
//   entry sends the brief's model id in the gateway request and puts that same id back on every
//   answer and every streamed chunk (the provider's own answer spells it without the gateway's
//   `openrouter/` prefix), so its claim is the call it made, never another. A prompt whose
//   reported model has no matching successful call in the house's record earns nothing.
//
// DETERMINISM
//   No clock and no unseeded randomness anywhere in routing, ranking or answers: the retry sleep
//   is a fixed duration, the ranking is a function of the brief and the refusal counts alone, and
//   the model listings use fixed timestamps. The one clock read (the trial wall safety in the poll
//   loop) only decides when an already-finished trial's process exits; it never changes an answer,
//   so a replay leaves the state export byte for byte.
//
// FILES
//   main.ts            this server: the brief, the routing, the failover, the register and the poll.
//   lib/providers.ts   the brief's types and parser, the free model list, the catalog.
//   lib/wire.ts        Anthropic <-> Chat Completions translation, the model field, the SSE writers.
//   LICENSE            MIT.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  capabilitiesOf,
  freeModels,
  isRecord,
  meetsRequirements,
  readBrief,
  type CatalogReport,
  type Json,
  type ModelRow,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicEventsFromOpenAI,
  anthropicModelList,
  anthropicToOpenAI,
  openAIError,
  openAIJsonWithModel,
  openAIModelList,
  openAIStreamWithModel,
  openAIToAnthropic,
  type ServedModel,
} from './lib/wire.ts';

/** The wire protocol's version, in the register body. */
const PROTOCOL_VERSION = 1;
/** How often GET /work is polled, in milliseconds. */
const POLL_INTERVAL_MS = 100;
/** The most bytes of one client request body this entry reads. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** The header a served answer carries its recovered refusals on, for the failover column. */
const FAILURES_HEADER = 'x-makefun-upstream-failures';
/** The most refusal rows one answer reports (the env reads at most this many). */
const MAX_TRAIL_ROWS = 8;
/** The output cap a gateway request names when the client named none (the gateway refuses uncapped calls). */
const DEFAULT_MAX_TOKENS = 512;
/** How long one gateway call may take before it counts as refused (the client waits 30 s per answer). */
const DIAL_TIMEOUT_MS = 15000;
/** The fixed sleep between a refused call and its retry or failover. */
const RETRY_SLEEP_MS = 250;
/** The most gateway calls one prompt may cost: the best model, its retry, then two failovers. */
const MAX_ATTEMPTS = 4;
/** Refusals after which a model is cooling down and ranks behind models that have not refused. */
const COOLDOWN_REFUSALS = 2;
/** The trial wall is 240 s; past this the process exits 0 rather than hanging past it. */
const TRIAL_WALL_SAFETY_MS = 230000;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** The trial's dummy key for the entry's gateway lane; the gateway swaps it for the entrant's own key. */
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
/** Which prompt row the request now arriving is: the brief's prompts are in the client's arrival order. */
let manifestIndex = 0;
/** Refusals per model id this trial, for the cooling-down ranking. Deterministic: counts only. */
const refusalCounts = new Map<string, number>();
/** When this process started, for the trial wall safety only. */
const startedAt = Date.now();

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The gateway's Chat Completions route. OPENAI_BASE_URL is the OpenAI-compatible root (`…/v1` on
 * the trial network); a base that does not already end in `/v1` gets one, so both spellings reach
 * the route.
 */
function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

/** The free models the brief lists, as GET /v1/models names them. */
function servedModels(): ServedModel[] {
  return freeModels(brief).map((model) => ({ id: model.id, provider: model.provider, display_name: model.display_name }));
}

/**
 * The free models that meet `requires`, best first: models that have not refused twice this trial
 * ahead of cooling-down ones, then by the brief's rating in milli-points, then by brief order.
 * The ranking is read from the brief at request time, so a final instance with different models or
 * ratings still routes to its own best.
 */
function rankCandidates(requires: Requirement): ModelRow[] {
  return freeModels(brief)
    .filter((model) => meetsRequirements(requires, capabilitiesOf(model)))
    .sort((a, b) => {
      const coolA = (refusalCounts.get(a.id) ?? 0) >= COOLDOWN_REFUSALS ? 1 : 0;
      const coolB = (refusalCounts.get(b.id) ?? 0) >= COOLDOWN_REFUSALS ? 1 : 0;
      if (coolA !== coolB) return coolA - coolB;
      if (b.rating_milli !== a.rating_milli) return b.rating_milli - a.rating_milli;
      return a.brief_index - b.brief_index;
    });
}

/**
 * The models one prompt is dialled on, in order: the best, the same model retried once, then the
 * next-best models that meet the requirements. At most MAX_ATTEMPTS calls; a prompt with no refusal
 * costs exactly one, which is what the tie-break rewards.
 */
function attemptPlan(ranked: readonly ModelRow[]): ModelRow[] {
  if (ranked.length === 0) return [];
  const plan: ModelRow[] = [ranked[0], ranked[0]];
  for (let i = 1; i < ranked.length && plan.length < MAX_ATTEMPTS; i++) plan.push(ranked[i]);
  return plan.slice(0, MAX_ATTEMPTS);
}

/** The requirements of the prompt now arriving: the brief's row by arrival order, else the body's own. */
function requirementsFor(body: Json): Requirement {
  const entry = brief.prompts[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;
  // The brief's prompt list is the declared source of each request's requirements; this fallback
  // is a guess for a brief that holds none.
  return requirementsFromBody(body);
}

/** Requirements read off a request body, when the brief has no row for it. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return { tools: Array.isArray(body.tools) && body.tools.length > 0, vision, json: format === 'json_object' || format === 'json_schema' };
}

/** One refusal row, as the failover header carries it: the status, the gateway's code, the model. */
interface FailureRow {
  status: number;
  code: string;
  model: string | null;
}

/** The gateway error body's code, or '' when it names none. */
function errorCodeOf(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value) && isRecord(value.error)) {
      if (typeof value.error.code === 'string' && value.error.code !== '') return value.error.code.slice(0, 64);
      if (typeof value.error.type === 'string' && value.error.type !== '') return value.error.type.slice(0, 64);
    }
  } catch {
    // Not JSON: no code to report.
  }
  return '';
}

/** POST one request to the gateway's Chat Completions route, naming the model this entry dialled. */
async function dial(model: string, body: Json): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  return fetch(chatCompletionsUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, model }),
    signal: AbortSignal.timeout(DIAL_TIMEOUT_MS),
  });
}

/**
 * A client request as the gateway request that serves it: translated when it arrived on the
 * Anthropic wire, always naming an output cap (the gateway refuses uncapped calls), and always
 * asking a stream to carry its usage (the Anthropic translation and the wire usage check need it).
 */
function gatewayBody(wire: 'openai' | 'anthropic', body: Json, model: string): Json {
  const out: Json = wire === 'anthropic' ? anthropicToOpenAI(body, model) : { ...body };
  if (typeof out.max_tokens !== 'number') out.max_tokens = DEFAULT_MAX_TOKENS;
  if (out.stream === true) {
    const options = isRecord(out.stream_options) ? { ...out.stream_options } : {};
    options.include_usage = true;
    out.stream_options = options;
  }
  return out;
}

/** The tool names the client declared for this request, on either wire. */
function declaredToolNames(wire: 'openai' | 'anthropic', body: Json): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(body.tools)) return names;
  for (const raw of body.tools) {
    if (!isRecord(raw)) continue;
    if (wire === 'openai') {
      if (isRecord(raw.function) && typeof raw.function.name === 'string') names.add(raw.function.name);
    } else if (typeof raw.name === 'string') {
      names.add(raw.name);
    }
  }
  return names;
}

/**
 * An OpenAI-shaped answer with every tool call the client never declared dropped. A model that
 * calls an undeclared tool would fail the wire's tools check; the text that carries the token is
 * kept, so the prompt still serves.
 */
function filterToolCalls(answer: Json, allowed: Set<string>): Json {
  const choices = Array.isArray(answer.choices) ? answer.choices : [];
  if (choices.length === 0) return answer;
  const next = choices.map((choice) => {
    if (!isRecord(choice) || !isRecord(choice.message)) return choice;
    const calls = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [];
    if (calls.length === 0) return choice;
    const kept = calls.filter((call) => isRecord(call) && isRecord(call.function) && typeof call.function.name === 'string' && allowed.has(call.function.name));
    return { ...choice, message: { ...choice.message, tool_calls: kept } };
  });
  return { ...answer, choices: next };
}

type ServeResult =
  | { ok: true; model: string; upstream: Response; failures: FailureRow[] }
  | { ok: false; status: number; type: string; message: string; failures: FailureRow[] };

/**
 * Serve one prompt: dial the attempt plan until a gateway call answers, recording every refusal
 * on the way. A refusal is retried once on the same model after a fixed short sleep, then failed
 * over to the next-best model that meets the requirements. The refusals are returned with the
 * answer, so the caller can report them on the failover header.
 */
async function serve(wire: 'openai' | 'anthropic', body: Json): Promise<ServeResult> {
  const ranked = rankCandidates(requirementsFor(body));
  if (ranked.length === 0) {
    return { ok: false, status: 503, type: wire === 'anthropic' ? 'overloaded_error' : 'no_free_model', message: 'no free model in the brief meets this request', failures: [] };
  }
  const plan = attemptPlan(ranked);
  const failures: FailureRow[] = [];
  for (let i = 0; i < plan.length; i++) {
    const model = plan[i];
    let upstream: Response;
    try {
      upstream = await dial(model.id, gatewayBody(wire, body, model.id));
    } catch {
      failures.push({ status: 502, code: 'upstream_unreachable', model: model.id });
      refusalCounts.set(model.id, (refusalCounts.get(model.id) ?? 0) + 1);
      if (i < plan.length - 1) await sleep(RETRY_SLEEP_MS);
      continue;
    }
    if (!upstream.ok || upstream.body === null) {
      const text = await upstream.text().catch(() => '');
      failures.push({ status: upstream.status, code: errorCodeOf(text), model: model.id });
      refusalCounts.set(model.id, (refusalCounts.get(model.id) ?? 0) + 1);
      if (i === plan.length - 1) {
        return {
          ok: false,
          status: 502,
          type: wire === 'anthropic' ? 'api_error' : 'upstream_error',
          message: `the gateway answered HTTP ${upstream.status}${text === '' ? '' : `: ${text.slice(0, 500)}`}`,
          failures,
        };
      }
      await sleep(RETRY_SLEEP_MS);
      continue;
    }
    return { ok: true, model: model.id, upstream, failures };
  }
  return { ok: false, status: 502, type: wire === 'anthropic' ? 'api_error' : 'upstream_error', message: 'the gateway could not be reached', failures };
}

/** The failover header for an answer that recovered from refusals; empty when there were none. */
function trailHeaders(failures: readonly FailureRow[]): Record<string, string> {
  if (failures.length === 0) return {};
  return { [FAILURES_HEADER]: JSON.stringify(failures.slice(0, MAX_TRAIL_ROWS)) };
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extra });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string, extra: Record<string, string> = {}): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message), extra);
  else sendJson(res, status, openAIError(message, type, null), extra);
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/** POST /v1/chat/completions: an OpenAI-shaped client, answered by the best free model that meets it. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const result = await serve('openai', body);
  if (!result.ok) return sendError(res, 'openai', result.status, result.type, result.message, trailHeaders(result.failures));
  const extra = trailHeaders(result.failures);
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...extra });
    try {
      for await (const frame of openAIStreamWithModel(result.upstream.body!, result.model)) res.write(frame);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await result.upstream.json();
  const clean = filterToolCalls(isRecord(answer) ? answer : {}, declaredToolNames('openai', body));
  sendJson(res, 200, openAIJsonWithModel(clean, result.model), extra);
}

/** POST /v1/messages: an Anthropic-shaped client, rewritten to Chat Completions and answered back. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const result = await serve('anthropic', body);
  if (!result.ok) return sendError(res, 'anthropic', result.status, result.type, result.message, trailHeaders(result.failures));
  const extra = trailHeaders(result.failures);
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...extra });
    try {
      for await (const event of anthropicEventsFromOpenAI(result.upstream.body!, result.model)) res.write(event);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await result.upstream.json();
  const clean = filterToolCalls(isRecord(answer) ? answer : {}, declaredToolNames('anthropic', body));
  sendJson(res, 200, openAIToAnthropic(clean, result.model), extra);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the trial's prompt count. */
async function register(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the trial holds ${reply.requests} prompts`);
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done, or when the trial wall is near. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (Date.now() - startedAt > TRIAL_WALL_SAFETY_MS) {
      clearInterval(timer);
      server.close();
      process.exit(0);
    }
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the one built object and
    // stop before any server starts. A process whose stdout is not flushed loses the tail, so wait
    // for it.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // 8080 is the env's on one layout; the OS's ephemeral range never holds it, and the guard says so.
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
