// Direct test of the entry against the bare-id mock gateway, without the forwarder.
//
// The grade-local masq lane requires the upstream to name the model exactly as requested, so it
// cannot test the entry's model-field replacement (the real OpenRouter names the model WITHOUT
// the `openrouter/` prefix, and the entry must put the dialled id back). This script does: it
// runs a stub env, the entry, and the mock gateway with MOCK_BARE=1, sends the practice trial's
// six workload bodies in manifest order, and checks every answer (model field, token, usage,
// stop reason, stream event order, both /v1/models wires) plus a clean exit 0.
//
// Usage: node dev/direct-test.mjs [trial] [mock-port]
//   trial defaults to 0; the mock gateway must already run on mock-port with MOCK_BARE=1.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const KIT = process.env.KIT ?? '/home/hatch/workspace/make-fun/kit/free-model-aggregator-02-kit';
const REPO = new URL('..', import.meta.url).pathname;
const TRIAL = Number(process.argv[2] ?? '0');
const MOCK_PORT = Number(process.argv[3] ?? '18081');
const ENV_PORT = 18180 + TRIAL;

const workload = JSON.parse(readFileSync(`${KIT}/practice/trial-${TRIAL}/input/env/workload.json`, 'utf8'));
const manifest = workload.manifest;
const bodies = workload.bodies;

// The expected model per prompt, computed independently from the brief's own ratings: the
// highest-rated free model meeting the prompt's requirements (ties: brief order). This is the
// routing the entry must reproduce; trial-1 assigns different wires/requirements per prompt.
const briefText = readFileSync(`${KIT}/practice/trial-${TRIAL}/input/prompt.txt`, 'utf8');
const briefModels = JSON.parse(briefText.split('\n').find((l) => l.startsWith('{"schema":"free-model-aggregator-02/models/v1"'))).models;
function meets(req, m) {
  if (req.tools === true && m.tools !== true) return false;
  if (req.vision === true && m.vision !== true) return false;
  if (req.json === true && m.json !== true) return false;
  return true;
}
const EXPECTED = {};
for (const p of manifest) {
  const cands = briefModels.filter((m) => m.free !== false && meets(p.requires ?? {}, m));
  cands.sort((a, b) => b.rating_milli - a.rating_milli);
  EXPECTED[p.id] = cands[0].id.startsWith('openrouter/') ? cands[0].id : `openrouter/${cands[0].id}`;
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// --- stub env: /register learns the entry's port; /work says done once told to. ---
let entryPort = 0;
let done = false;
const env = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://env');
  if (req.method === 'POST' && url.pathname === '/register') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        entryPort = JSON.parse(raw).port;
      } catch {
        entryPort = 0;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, requests: manifest.length }));
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/work') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ done }));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => env.listen(ENV_PORT, '127.0.0.1', resolve));

// --- the entry, against the bare-id mock. ---
const entry = spawn('node', ['main.ts'], {
  cwd: REPO,
  env: {
    ...process.env,
    MAKEFUN_PROMPT_FILE: `${KIT}/practice/trial-${TRIAL}/input/prompt.txt`,
    MAKEFUN_ENV_URL: `http://127.0.0.1:${ENV_PORT}`,
    OPENAI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    OPENAI_API_KEY: 'dummy-direct-test-key',
    ANTHROPIC_API_KEY: 'dummy-direct-test-key',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
entry.stderr.on('data', (c) => process.stderr.write(`[entry] ${c}`));
const exitPromise = new Promise((resolve) => entry.on('exit', (code) => resolve(code)));

// Wait for registration (up to 10 s).
for (let i = 0; i < 100 && entryPort === 0; i++) await new Promise((r) => setTimeout(r, 100));
check('entry registered with the stub env', entryPort !== 0, `port=${entryPort}`);
if (entryPort === 0) {
  entry.kill();
  env.close();
  process.exit(1);
}

async function post(path, body, headers) {
  const res = await fetch(`http://127.0.0.1:${entryPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return res;
}

const TOKEN_RE = /[A-Z]{2,12}-\d{4}/;

for (const prompt of manifest) {
  const id = prompt.id;
  const body = bodies[id];
  const token = (JSON.stringify(body).match(TOKEN_RE) ?? [null])[0];
  const expectedModel = EXPECTED[id];
  const isAnthropic = prompt.api === 'anthropic';
  const path = isAnthropic ? '/v1/messages' : '/v1/chat/completions';
  const headers = isAnthropic ? { 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' } : { authorization: 'Bearer test-key' };
  if (prompt.stream) headers.accept = 'text/event-stream';
  const res = await post(path, body, headers);
  const text = await res.text();
  check(`${id} status 200`, res.status === 200, `got ${res.status}: ${text.slice(0, 200)}`);
  if (res.status !== 200) continue;
  check(`${id} no failover trail needed (mock never refuses)`, res.headers.get('x-makefun-upstream-failures') === null);

  if (!prompt.stream) {
    let answer;
    try {
      answer = JSON.parse(text);
    } catch {
      answer = null;
    }
    check(`${id} answer is JSON`, answer !== null);
    if (answer === null) continue;
    if (isAnthropic) {
      check(`${id} model is the dialled id`, answer.model === expectedModel, `got ${answer.model}`);
      const joined = (answer.content ?? []).map((b) => b.text ?? '').join('');
      check(`${id} body carries the token`, joined.includes(token), `token=${token}`);
      check(`${id} stop_reason is end_turn`, answer.stop_reason === 'end_turn', `got ${answer.stop_reason}`);
      check(`${id} usage output >= 1`, (answer.usage?.output_tokens ?? 0) >= 1, `got ${JSON.stringify(answer.usage)}`);
      if (body.response_format !== undefined) check(`${id} (n/a: anthropic has no json mode)`, true);
    } else {
      check(`${id} model is the dialled id`, answer.model === expectedModel, `got ${answer.model}`);
      const content = answer.choices?.[0]?.message?.content ?? '';
      check(`${id} body carries the token`, content.includes(token), `token=${token}`);
      if (body.response_format?.type === 'json_object') {
        let parsed = null;
        try {
          parsed = JSON.parse(content);
        } catch {
          parsed = null;
        }
        check(`${id} JSON mode answer parses with the token`, parsed !== null && parsed.token === token, `got ${content}`);
      }
      check(`${id} finish_reason is stop`, answer.choices?.[0]?.finish_reason === 'stop', `got ${answer.choices?.[0]?.finish_reason}`);
      check(`${id} usage output >= 1`, (answer.usage?.completion_tokens ?? 0) >= 1, `got ${JSON.stringify(answer.usage)}`);
    }
  } else {
    // Streaming: parse the SSE frames.
    const frames = text.split('\n\n').filter((f) => f.trim() !== '');
    const datas = [];
    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (line.startsWith('data:')) datas.push(line.slice(5).trim());
      }
    }
    check(`${id} stream ends with [DONE]`, isAnthropic ? !datas.includes('[DONE]') : datas[datas.length - 1] === '[DONE]', isAnthropic ? 'anthropic streams end with message_stop, not [DONE]' : '');
    if (isAnthropic) {
      const events = [];
      let joined = '';
      let stopReason = null;
      let outputTokens = 0;
      for (const frame of frames) {
        const eventLine = frame.split('\n').find((l) => l.startsWith('event:'));
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (payload === '[DONE]') continue;
        let doc;
        try {
          doc = JSON.parse(payload);
        } catch {
          continue;
        }
        events.push(eventLine ? eventLine.slice(7).trim() : '(none)');
        if (doc.type === 'message_start') check(`${id} message_start names the dialled model`, doc.message?.model === expectedModel, `got ${doc.message?.model}`);
        if (doc.type === 'content_block_delta' && doc.delta?.type === 'text_delta') joined += doc.delta.text;
        if (doc.type === 'message_delta') {
          stopReason = doc.delta?.stop_reason;
          outputTokens = doc.usage?.output_tokens ?? 0;
        }
      }
      const order = events.join(',');
      const orderOk = /^message_start,content_block_start,(content_block_delta,)+content_block_stop,message_delta,message_stop$/.test(order);
      check(`${id} anthropic event order`, orderOk, `got ${order}`);
      check(`${id} stream body carries the token`, joined.includes(token), `token=${token}`);
      check(`${id} stream stop_reason is end_turn`, stopReason === 'end_turn', `got ${stopReason}`);
      check(`${id} stream usage output >= 1`, outputTokens >= 1, `got ${outputTokens}`);
    } else {
      let joined = '';
      let sawUsage = false;
      let finish = null;
      let allModelOk = true;
      for (const payload of datas) {
        if (payload === '[DONE]') continue;
        let doc;
        try {
          doc = JSON.parse(payload);
        } catch {
          continue;
        }
        if (doc.model !== expectedModel) allModelOk = false;
        const delta = doc.choices?.[0]?.delta;
        if (typeof delta?.content === 'string') joined += delta.content;
        if (doc.choices?.[0]?.finish_reason) finish = doc.choices[0].finish_reason;
        if (doc.usage) {
          sawUsage = true;
          check(`${id} stream usage output >= 1`, (doc.usage.completion_tokens ?? 0) >= 1, `got ${JSON.stringify(doc.usage)}`);
        }
      }
      check(`${id} every chunk names the dialled model`, allModelOk);
      check(`${id} stream body carries the token`, joined.includes(token), `token=${token}`);
      check(`${id} stream finish_reason is stop`, finish === 'stop', `got ${finish}`);
      check(`${id} stream carries a usage chunk`, sawUsage);
    }
  }
}

// --- GET /v1/models on both wires: exactly the fourteen dialable ids. ---
for (const [name, headers] of [
  ['openai', { authorization: 'Bearer test-key' }],
  ['anthropic', { 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' }],
]) {
  const res = await fetch(`http://127.0.0.1:${entryPort}/v1/models`, { headers });
  const doc = await res.json();
  const ids = (doc.data ?? []).map((m) => m.id);
  check(`GET /v1/models (${name}) lists 14 ids`, ids.length === 14, `got ${ids.length}`);
  check(`GET /v1/models (${name}) ids are the dialable set`, ids.every((id) => id.startsWith('openrouter/') && id.endsWith(':free')));
  if (name === 'openai') check('GET /v1/models (openai) shape', doc.object === 'list' && doc.data[0]?.object === 'model');
  if (name === 'anthropic') check('GET /v1/models (anthropic) shape', doc.has_more === false && doc.data[0]?.type === 'model');
}

// --- clean exit: the stub env says done, the entry must exit 0. ---
done = true;
const code = await Promise.race([exitPromise, new Promise((r) => setTimeout(() => r('timeout'), 10000))]);
check('entry exits 0 when the trial is done', code === 0, `got ${code}`);
if (code !== 0 && code !== 'timeout') entry.kill();
if (code === 'timeout') entry.kill();
env.close();

console.log(failures === 0 ? `\nDIRECT TEST: all checks passed (trial-${TRIAL})` : `\nDIRECT TEST: ${failures} check(s) failed (trial-${TRIAL})`);
process.exit(failures === 0 ? 0 : 1);
