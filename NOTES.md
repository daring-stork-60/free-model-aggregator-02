# free-model-aggregator-02 — NOTES

Entry untuk bounty make.fun **free-model-aggregator-02** ("The best live free-model aggregator",
$500: 1st $100, 2nd $70, 3rd $50, 4th–10th $20, 11th–20th $14). Entries tutup
**2026-11-17T03:30:00Z** (Tue 2026-11-17 10:30 WIB). Akun: **@daring-stork-60** (wallet A1).
753 entries per 16 Nov 2026 07:24 UTC.

Status: **SIAP SUBMIT secara teknis, TERBLOKIR satu prerequisite — kunci OpenRouter**
(lihat "BLOCKER" di bawah). Entry TIDAK disubmit oleh subagent ini; tidak ada repo GitHub dibuat.

## Apa yang dibangun

Satu server Node 22 (stdlib saja, tanpa dependensi) di repo ini:

| File | Isi |
|---|---|
| `main.ts` | server HTTP, routing by rating, failover + trail header, register + poll |
| `lib/providers.ts` | parser brief (2 dokumen JSON di prompt.txt), daftar model gratis, katalog |
| `lib/wire.ts` | terjemahan OpenAI ↔ Anthropic (JSON + SSE), model field, event order |
| `dev/mock-gateway.mjs` | mock OpenRouter untuk tes lokal (bukan bagian entry) |
| `dev/direct-test.mjs` | tes langsung entry vs mock bare-id (bukan bagian entry) |
| `README.md`, `LICENSE` (MIT), `.gitignore` | dokumen entry |

### Cara kerja (ringkas)

- **Routing kualitas.** Setiap prompt dilayani model gratis berperingkat tertinggi yang memenuhi
  requirements-nya (tools/vision/json/min_context), dibaca dari brief saat request tiba — tidak
  ada model yang di-hardcode, jadi instance final dengan model/rating berbeda tetap ter-route ke
  yang terbaik. Pada brief latihan: prompt JSON → `nvidia/nemotron-3.5-super-vl:free` (1.303,
  JSON-capable terbaik); prompt biasa/tools → `thinkingmachines/inkling-2-small:free` (1.475,
  terbaik keseluruhan).
- **Failover.** Penolakan gateway (4xx/5xx/timeout 15 dtk) → retry sekali pada model yang sama
  setelah sleep tetap 250 ms → failover ke model terbaik berikutnya yang memenuhi syarat,
  maksimal 4 panggilan gateway per prompt (1 panggilan kalau tidak ada penolakan — optimal untuk
  tie-break). Setiap penolakan dicatat dan dilaporkan di header jawaban
  `x-makefun-upstream-failures` (`[{status, code, model}]`, maks 8 baris) — satu-satunya cara
  kolom failover melihat penolakan yang pulih. Model yang sudah menolak 2x dalam satu trial
  dianggap cooling down dan diurutkan di belakang model yang belum menolak (berbasis hitungan,
  bukan jam — replay-safe).
- **Dua wire.** `POST /v1/chat/completions` (OpenAI) dan `POST /v1/messages` (Anthropic), JSON
  dan SSE. Request Anthropic diterjemahkan ke Chat Completions (system prompt, gambar, tools,
  tool_choice, max_tokens, stream); jawaban diterjemahkan kembali termasuk urutan event
  `message_start → content_block_start → delta → content_block_stop → message_delta →
  message_stop`, usage dan stop reason diteruskan utuh. ID model yang di-dial dikembalikan di
  setiap jawaban dan setiap chunk stream (provider menyebut model tanpa prefix `openrouter/`;
  entry memasang kembali ID lengkap). Tool call untuk nama tool yang tidak dideklarasikan klien
  dibuang (hanya jawaban non-stream; lihat "Keterbatasan").
- **Katalog.** Catalog yang diregistrasi + kedua jawaban `GET /v1/models` berisi tepat 14 model
  `:free` dari brief, masing-masing sekali, dengan `base_url https://openrouter.ai/api/v1` dan
  `key_env OPENROUTER_API_KEY`. `node main.ts --list` mencetak katalog yang sama byte-for-byte;
  tanpa brief mencetak `{"providers":[]}`.
- **Deterministik.** Tanpa jam dan tanpa randomness di routing/ranking/jawaban (satu-satunya
  pembacaan jam adalah safety exit 230 dtk di poll loop, yang tidak mengubah jawaban apa pun),
  sehingga replay menghasilkan state export yang identik byte-for-byte.
- **max_tokens** selalu disebut (default 512 bila klien tidak menyebut), dan stream selalu
  meminta `stream_options.include_usage` agar usage sampai di chunk terakhir.

### Keterbatasan yang diketahui

- Filter tool tak dideklarasikan hanya diterapkan pada jawaban non-stream. Prompt trial tidak
  pernah meminta model memanggil tool (p05 malah melarang), jadi risikonya kecil; stream dengan
  tool call tak dideklarasikan akan lolos apa adanya.
- Timeout satu panggilan gateway 15 dtk: model gratis yang lambat tapi sehat (>15 dtk) akan
  dianggap menolak dan di-retry/failover. Prompt trial hanya meminta echo satu token, jadi
  jawaban sehat normalnya <5 dtk.

## Hasil tes (semua di VM ini, 16 Nov 2026)

Kit: `~/workspace/make-fun/kit/free-model-aggregator-02-kit`. Docker TIDAK ada di VM ini,
sehingga `grade-local` hanya bisa jalan dengan `--driver process` — dan driver process hanya
menjalankan entry Node (entry Python hanya jalan di Docker). Itu alasan entry ini ditulis
dalam Node (main.ts), bukan Python.

### 1. grade-local lewat pipeline resmi kit (env + gateway forwarder + scorer + replay)

| Uji | Hasil |
|---|---|
| `--instances 1` (trial-0), gateway normal | **skor 100**: quality 100, served 100, wire 100, failover 100, catalog 100, working 1; upstream_calls 6; replay OK (state identik) |
| `--instances 2` (trial-0 + trial-1) | **100/100 di kedua trial**, replay OK, 6 panggilan tiap trial |
| `FAIL_FIRST=1` (panggilan gateway pertama 429) | **skor 100**; 7 panggilan gateway (1 retry pada model yang sama, berhasil); failover 100; state export membuktikan trail header terbaca: p01 `failures: [{status: 429, code: 'rate_limit_exceeded', model: 'openrouter/nvidia/nemotron-3.5-super-vl:free'}]`, `failed_prompts: 1, failover_handled: 1`; 39/39 checks lolos |
| `FAIL_MODEL=inkling-2-small` (model terbaik 429 sepanjang trial) | **skor 94**: quality 90, served 100, wire 100, failover 100, catalog 100; 8 panggilan gateway (cooldown menghemat panggilan: setelah 2 penolakan inkling, prompt berikutnya langsung ke super-vl); replay OK |

Catatan: forwarder masq (`--gateway`) mem-vetting jawaban upstream — model di jawaban harus
sama persis dengan yang diminta (termasuk prefix `openrouter/`). Mock gateway default menjawab
dengan ID lengkap karena itu; mode `MOCK_BARE=1` meniru OpenRouter asli (ID tanpa prefix) dan
dipakai pada direct test di bawah. Perilaku entry sendiri tidak bergantung pada ejaan ini:
entry selalu menulis ulang field model dengan ID yang di-dial.

### 2. Direct test vs mock bare-id (tanpa forwarder)

`node dev/direct-test.mjs 0` dan `node dev/direct-test.mjs 1` (mock di port 18081,
`MOCK_BARE=1`): **semua checks lolos di kedua trial** — field model = ID yang di-dial
meskipun mock menjawab bare, token terbawa di semua 6 jawaban, JSON mode ter-parse
(`{"token": ...}`), urutan event stream Anthropic benar, usage output ≥ 1 di semua jawaban,
kedua wire `GET /v1/models` berisi 14 ID, entry exit 0 saat trial selesai.

### 3. `--list`

`MAKEFUN_PROMPT_FILE=<trial-0 prompt.txt> node main.ts --list` → katalog 14 model, exit 0.
Tanpa brief → `{"providers":[]}`, exit 0.

### Kuota (cek 16 Nov 2026 ~07:41 UTC)

`GET /api/competitions/free-model-aggregator-02/quota`: `can_submit: true`, day cap 10
(left 10, reset 2026-11-17T00:00:00Z), total max 20 (left 20), entries made 0. **Cek ulang
saat submit.** Tidak ada entry fee. `handed_over_places: "none"`.

## BLOCKER — kunci OpenRouter (prerequisite yang belum terpenuhi)

Entry ini **tidak bisa dinilai tanpa kunci OpenRouter**: "Needs an OpenRouter key" — akun
OpenRouter dengan minimal 10 credits yang dibeli, dan API key-nya. Tanpa key yang di-push,
setiap panggilan model ditolak HTTP 401, tidak ada prompt yang dilayani, entry tidak
di-ranking (skor 0). **Tidak ditemukan `OPENROUTER_API_KEY` di environment maupun file `.env`
mana pun di workspace** — jangan ditebak, minta ke user.

Setelah user memberikan key, push ke kompetisi (JANGAN pernah menaruh key di command line,
JANGAN commit — check `committed_secret`/`committed_provider_key` menolaknya):

```sh
# buat file .env berisi SATU baris: OPENROUTER_API_KEY=<key dari user>
# lalu, dari direktori kit:
node cli/makefun.mjs secrets push free-model-aggregator-02 --dotenv <file .env>
```

Key yang di-push TIDAK masuk ke sandbox trial; gateway menukar dummy key trial dengan key
ini di sisi server. Biaya live grading dibebankan ke key user (anggaran $0.01/trial di
grade-local; trial final memakai key yang sama).

## Langkah submit (untuk parent — JANGAN dijalankan subagent ini)

Urutan yang benar (cek `makefun check` sebelum `submit`):

```sh
KIT=~/workspace/make-fun/kit/free-model-aggregator-02-kit
REPO=~/workspace/make-fun/free-model-aggregator-02
cd $REPO
```

1. **Kunci OpenRouter** — push seperti di atas. Wajib sebelum submit.
2. **Repo GitHub** (jalur utama): user membuat repo publik baru (mis. `free-model-aggregator-02`),
   push isi repo ini ke sana. Lalu di `README.md` ganti `{owner}` pada dua badge rank/reward
   dengan owner GitHub yang sebenarnya (saat ini masih placeholder — intake menolak README yang
   masih mengandung `{owner}`). Set GitHub About repo:
   ```sh
   gh repo edit <owner>/free-model-aggregator-02 \
     --description 'Live free-model aggregator. Built by an AI agent for make.fun'"'"'s "The best live free-model aggregator" bounty, $500 in USDC.' \
     --homepage 'https://make.fun/bounty/free-model-aggregator-02' \
     --add-topic 'makefun,ai-agents,bounties,code'
   ```
   (website https://make.fun/bounty/free-model-aggregator-02, topik `makefun` — wajib.)
   Commit + push, catat SHA commit 40-karakter (`git rev-parse HEAD`).
   - **Jalur alternatif tanpa GitHub (source bundle):** repo harus diawali `init` di repo KOSONG
     SEBELUM file entry ada — repo ini sudah berisi file + LICENSE, jadi tidak bisa dipakai
     apa adanya. Buat direktori repo baru, jalankan
     `(cd <repo baru> && node $KIT/cli/makefun.mjs init --license MIT --keypair ~/workspace/make-fun/makefun-keypair.json)`,
     lalu salin file entry ke sana, commit di atas root commit init (jangan rewrite root),
     dan submit dengan `--source` + `repo_url` berupa `bundle:<root sha>`. Lihat RULES.txt
     bagian 5 untuk detailnya.
3. **Bundle transkrip** — HARUS dibuat parent SETELAH subagent ini selesai (usage row subagent
   baru ditulis saat run-nya selesai; bundle yang dibuat sebelumnya akan ditolak karena 0 usage
   rows). Dari direktori repo:
   ```sh
   node $KIT/cli/makefun.mjs bundle --repo . --out /tmp/fma02-bundle.tar.gz \
     --mcp none --provider meta --model muse-spark-1.3 --effort default \
     --harness muse-app --harness-version <versi aplikasi Muse>
   ```
   Nilai `--harness-version` belum diketahui pasti oleh subagent ini (sesi ini mencatat
   `harness: agent/v1`; versi aplikasi Muse harus dikonfirmasi parent). `--mcp none` karena
   sesi ini tidak memakai MCP server. Bila bundle menolak karena flag kurang, ikuti pesan
   `to fix:` yang dicetaknya. Verifikasi dengan `bundle --dry-run` dulu (sudah terbukti
   menemukan 2 sesi: subagent ini + parent).
4. **Pre-submit check:**
   ```sh
   node $KIT/cli/makefun.mjs check --kit $KIT --repo $REPO --transcripts /tmp/fma02-bundle.tar.gz
   ```
   Harus lolos semua (termasuk `repo_readme`, `repo_about`, transcript gate).
5. **Submit** (kuota: cek ulang `GET /api/competitions/free-model-aggregator-02/quota` dulu):
   ```sh
   node $KIT/cli/makefun.mjs submit --competition free-model-aggregator-02 \
     --repo-url https://github.com/<owner>/free-model-aggregator-02 \
     --commit <sha 40-karakter> \
     --title "free-model-aggregator-02" \
     --bundle /tmp/fma02-bundle.tar.gz \
     --keypair ~/workspace/make-fun/makefun-keypair.json
   ```
   Submit menandatangani entry message dengan wallet A1 (keypair di atas). Entry message
   diterbitkan ≤10 menit sebelum submit (CLI yang mengurusnya). Deadline:
   **2026-11-17T03:30:00Z**. Entri yang diterima mulai 17 Nov 2026 00:00 UTC butuh run record
   (bundle menyertakannya bila dibuat setelah grade-local; `check` memvalidasinya).

## Penilaian jujur peluang top 20

- **Secara teknis entry ini maksimal pada apa yang bisa diuji lokal: 100/100 di kedua practice
  trial, replay deterministik, failover terbukti.** Routing kualitasnya optimal (model terbaik
  per prompt), wire-nya bersih (39/39 checks), katalog tepat, dan tie-break panggilan minimal
  (6 panggilan sukses per trial — tidak bisa lebih sedikit).
- **Yang tidak bisa diuji lokal adalah kualitas jawaban model LIVE.** Skor quality di final
  bergantung pada model yang benar-benar menjawab lewat OpenRouter pada key user: bila
  inkling-2-small / nemotron-3.5-super-vl menjawab dengan token yang benar (seperti yang
  diasumsikan mock), quality tetap 100. Bila salah satu model live itu menolak/mengembalikan
  jawaban tanpa token, failover menurunkannya secara graceful (pengujian worst-case: model
  terbaik mati total sepanjang trial → skor 94, masih sangat kompetitif).
- **Risiko utama di luar kendali entry:** (1) key OpenRouter belum ada — tanpa itu skor 0;
  (2) rate limit model gratis di final (10.517 entry chess vs 753 di sini — kompetisi ini
  relatif sepi, 753 entry, dan hanya top 60 yang lanjut ke 3 trial; entry yang bekerja di
  semua trial punya peluang bagus); (3) instance final bisa memakai model/rating berbeda —
  entry membaca brief saat runtime, jadi adaptif, tapi model baru yang belum dikenal tetap
  bergantung pada rating di brief.
- **Perkiraan:** bila key di-push dan submit dilakukan dengan benar sebelum deadline, entry ini
  **layak top 20, dengan peluang realistis top 10** — skor dev 100/100 dan failover yang
  teruji adalah profil pemenang, asal model live menjawab seperti yang diharapkan. Tanpa key,
  peluangnya **nol**. Prioritas sekarang: minta key ke user, buat repo, submit.
