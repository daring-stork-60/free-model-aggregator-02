// Mock gateway for local testing only — never part of the entry.
//
// A tiny OpenAI-compatible Chat Completions endpoint that stands in for OpenRouter behind the
// kit's gateway forwarder (`grade-local --gateway <this url>`). It answers every prompt with the
// token the prompt carries, so the scorer can prove the entry served the prompt with the model it
// dialled. Its answers spell the model WITHOUT the `openrouter/` prefix, exactly as OpenRouter
// does, so the entry's model-field replacement is exercised.
//
// Failure injection (env vars), for failover tests:
//   FAIL_FIRST=N        the first N calls answer 429 rate_limit_exceeded
//   FAIL_MODEL=<id>     every call for that model (bare or prefixed id) answers 429
//   FAIL_ALWAYS=1       every call answers 500
//   MOCK_BARE=1         answer with the model id WITHOUT the `openrouter/` prefix, as the real
//                       OpenRouter does (the masq vetting in grade-local needs the exact dialled
//                       id, so this is off by default; use it only for direct tests of the
//                       entry's model-field replacement, without the forwarder)
// Every call is appended to dev/mock-gateway-log.jsonl: {n, model, stream, status, token}.
//
// Usage: node dev/mock-gateway.mjs [port]   (default 18080)

import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const PORT = Number(process.argv[2] ?? '18080');
const FAIL_FIRST = Number(process.env.FAIL_FIRST ?? '0');
const FAIL_MODEL = process.env.FAIL_MODEL ?? '';
const FAIL_ALWAYS = process.env.FAIL_ALWAYS === '1';
const MOCK_BARE = process.env.MOCK_BARE === '1';
const LOG = new URL('./mock-gateway-log.jsonl', import.meta.url);

const TOKEN_RE = /[A-Z]{2,12}-\d{4}/;
let calls = 0;

function bareModel(id) {
  return id.startsWith('openrouter/') ? id.slice('openrouter/'.length) : id;
}

function textOfMessages(messages) {
  const parts = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (typeof m?.content === 'string') parts.push(m.content);
    else if (Array.isArray(m?.content)) {
      for (const b of m.content) if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
  }
  return parts.join('\n');
}

function answerText(body) {
  const token = (textOfMessages(body.messages).match(TOKEN_RE) ?? [null])[0];
  if (token === null) return 'HELLO-0000';
  const format = body.response_format;
  if (format && typeof format === 'object' && format.type === 'json_object') return JSON.stringify({ token });
  return token;
}

function errorBody(status, code, message) {
  return JSON.stringify({ error: { message, type: code === 'rate_limit_exceeded' ? 'rate_limit_error' : 'api_error', code } });
}

function logCall(entry) {
  try {
    appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
  } catch {
    // Logging must never break an answer.
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://mock');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method !== 'POST' || (url.pathname !== '/chat/completions' && url.pathname !== '/v1/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found', type: 'not_found', code: 'not_found' } }));
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      body = {};
    }
    calls += 1;
    const model = typeof body.model === 'string' ? body.model : '';
    const token = (textOfMessages(body.messages).match(TOKEN_RE) ?? [null])[0];

    // Failure injection, in order: always, per-model, first-N.
    let fail = null;
    if (FAIL_ALWAYS) fail = { status: 500, code: 'internal_error', message: 'mock upstream error' };
    else if (FAIL_MODEL !== '' && (model === FAIL_MODEL || bareModel(model) === FAIL_MODEL || bareModel(model) === bareModel(FAIL_MODEL))) {
      fail = { status: 429, code: 'rate_limit_exceeded', message: 'Rate limit exceeded for this model' };
    } else if (calls <= FAIL_FIRST) {
      fail = { status: 429, code: 'rate_limit_exceeded', message: 'Rate limit exceeded' };
    }
    if (fail !== null) {
      logCall({ n: calls, model, stream: body.stream === true, status: fail.status, token });
      res.writeHead(fail.status, { 'content-type': 'application/json' });
      res.end(errorBody(fail.status, fail.code, fail.message));
      return;
    }

    const text = answerText(body);
    // The masq vetting (grade-local --gateway) requires the answer to name the model exactly as
    // requested, prefix included; the real OpenRouter names it bare, which MOCK_BARE mimics.
    const served = MOCK_BARE ? bareModel(model) : model;
    const id = `chatcmpl-mock-${calls}`;
    const created = 1763280000;
    const promptTokens = 24;
    const completionTokens = Math.max(1, text.split(/\s+/).length);
    const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
    logCall({ n: calls, model, stream: body.stream === true, status: 200, token });

    if (body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      // Split the answer into two content chunks, then the finish chunk, then usage, then [DONE].
      const mid = Math.max(1, Math.floor(text.length / 2));
      const parts = [text.slice(0, mid), text.slice(mid)];
      for (const part of parts) {
        if (part === '') continue;
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: served, choices: [{ index: 0, delta: { role: 'assistant', content: part }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: served, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      if (body.stream_options?.include_usage === true) {
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: served, choices: [], usage })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created,
        model: served,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage,
      }),
    );
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`mock-gateway: listening on 127.0.0.1:${PORT} (FAIL_FIRST=${FAIL_FIRST} FAIL_MODEL=${FAIL_MODEL || '-'} FAIL_ALWAYS=${FAIL_ALWAYS ? '1' : '0'})\n`);
});
