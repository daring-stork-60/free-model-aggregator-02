# free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/{owner}/free-model-aggregator-02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/{owner}/free-model-aggregator-02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

<!-- NOTE TO THE SUBMITTER: replace {owner} above with the GitHub owner of this repository
     before submitting — the make.fun intake refuses a README that still carries the placeholder. -->

A live free-model aggregator: one server that serves the OpenAI Chat Completions API and the
Anthropic Messages API, in JSON and in server-sent events, and answers every prompt with a real
completion from a live free OpenRouter model — ranked by published quality, with rate-limit-aware
failover, behind both wires in one zero-config process.

## Run it

```sh
node main.ts --list
```

`--list` prints the catalog this server can serve and exits. In a trial the harness runs
`node /bot/main.ts` with `MAKEFUN_PROMPT_FILE`, `MAKEFUN_ENV_URL`, `OPENAI_BASE_URL` and a dummy
`OPENAI_API_KEY` set; the server registers with the env, serves the six prompts, and exits 0
when the env says the trial is done. Node 22, standard library only — nothing is installed.

## How it works

- **Quality (60% of the score).** Every prompt is served by the highest-rated free model that
  meets its requirements — tools, vision, JSON mode, minimum context — ranked from the brief's
  own ratings at request time, never hardcoded. A final instance with different models or ratings
  still routes to its own best. On the practice briefs that means
  `thinkingmachines/inkling-2-small:free` (1,475) for plain and tool prompts and
  `nvidia/nemotron-3.5-super-vl:free` (1,303) for JSON-mode prompts, the best JSON-capable free
  model.
- **Failover (10%).** A refused gateway call is retried once on the same model after a fixed
  250 ms sleep, then failed over to the next-best model that meets the requirements — at most
  four gateway calls per prompt, one when nothing refuses. Every refusal is reported on the
  answer in the `x-makefun-upstream-failures` header, so a prompt that was refused and still
  served counts as handled. A model that has refused twice this trial is cooling down and ranks
  behind models that have not, so one rate-limited model cannot take every later prompt down.
- **Both wires.** `POST /v1/chat/completions` and `POST /v1/messages`, JSON and SSE streaming.
  Anthropic requests are rewritten to Chat Completions (system prompt, images, tool definitions,
  tool results, tool choice) and answers are rewritten back, including the
  `message_start` / `content_block_*` / `message_delta` / `message_stop` event order, usage and
  stop reason passed through whole. The dialled model id is put back on every answer and every
  streamed chunk, and a tool call for a name the client never declared is dropped.
- **Catalog (5%).** The registered catalog and both `GET /v1/models` answers list exactly the
  free models the brief names — all fourteen `:free` ids, once each.
- **Deterministic.** No clock and no unseeded randomness in routing, ranking or answers, so a
  replay leaves the trial's state export byte for byte.

## Layout

```text
main.ts            the server: the brief, the routing, the failover, the register and the poll
lib/providers.ts   the brief's parser, the free model list, the catalog
lib/wire.ts        Anthropic <-> Chat Completions translation, the model field, the SSE writers
dev/               local test harness only (mock gateway, direct test) — not part of the entry
LICENSE            MIT
NOTES.md           design, test results, and how to submit this entry
```

## Local tests

`dev/mock-gateway.mjs` stands in for OpenRouter behind the kit's gateway forwarder, and
`dev/direct-test.mjs` drives the entry against it with the mock naming models bare, as the real
OpenRouter does. Practice trials through the kit's own grader (`grade-local --driver process`):
**100/100 on trial-0 and trial-1**, replay byte-for-byte, 6 upstream calls each. With the first
gateway call forced to 429: still **100/100** (one retry, served). With the best model forced
to 429 for the whole trial: **94/100** (quality 90, everything else 100). See NOTES.md.

---

<sub>Entered on [make.fun](https://make.fun/?ref=0cnt242b&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards</sub>
