# Ask (assistant)

The question box that answers with numbers and opens filtered reports.

## Assistant (Ask)

`assistant.html` (shell item **Ask**, and **Ask: …** in ⌘K) answers questions and opens reports already filtered, through `POST /api/assistant` in `server.js`. The model is chosen by env settings (see below): **DeepSeek V4.1 Flash on Gödel Machines** (`deepseek/deepseek-v4.1-flash`, OpenAI-compatible API) or **Claude Haiku** (`claude-haiku-5-5`, effort `low`, through `@anthropic-ai/sdk`). The page footer names the model in use ("Answers by DeepSeek V4.1 Flash"), read from `/api/auth/config` (`assistantProvider`, `assistantModel`; never keys).

- **Who runs what:** the route only holds the key, fixes the model / system prompt / tools, validates the conversation (≤ 60 messages, ≤ 200 KB, user/assistant only) and rate-limits per user (60 questions per 10 minutes). The **browser** runs the tools: `query_report` counts NSC, load extension, solar and loss from the DataHub cache after `MzoScope.filterRows`, so answers respect the login scope and only aggregates (no names / phones) are sent to the model; `open_report` turns a report + filters + view into a link button; `get_briefing` reads `/api/executive/briefing`.
- **Catalogue:** `lib/assistant_catalog.js` (shared by server and browser) lists every report, its URL filters (`region`, `division`, `ccc`, `q`) and named views (e.g. `nsc.over_30_days` → `kpi=delay30`). When a page gains a deep-link parameter, add it there. To make another report answerable, add an adapter in `assistant.html` and set `data: true`.
- The conversation lives in `sessionStorage` (`mzo_assistant_v1`) in Anthropic Messages format whatever the provider (Claude's thinking blocks are passed back unchanged); **New chat** clears it.

## Providers (`lib/assistant/`)

| File | What it does |
|---|---|
| `index.js` | Reads the env settings, picks the provider, runs the concurrency gate, validates conversations, logs each call. One interface for `server.js`: `complete({ userNote, messages, signal })` → `{ content, stop_reason, usage, provider, model }`, content in Anthropic block format |
| `prompt.js` | The shared system prompt and the three tools, built from the catalogue |
| `anthropic.js` | Anthropic Messages API, unchanged from before: shared prompt cached (`cache_control`), 16000 max tokens, SDK retries 2, 60 s timeout |
| `openai_compat.js` | Gödel Machines or any OpenAI-compatible `/chat/completions`: translates the Anthropic-format conversation (system → system message, tools → functions, `tool_use` ↔ `tool_calls`, `tool_result` → `role: tool`, thinking blocks dropped, reasoning text ignored, `finish_reason` → `stop_reason`), parses tool arguments (malformed → `{}`, which the browser rejects as a tool error so the model retries). 8000 max tokens (reasoning counts as output), 60 s per attempt, one retry on 429 / 5xx / network error honouring `Retry-After` up to 10 s. Adds a short tool-rules addendum to the prompt for DeepSeek |
| `errors.js` | One error type and the user-facing replies |
| `usage.js` | Usage tracking: one row per model call (PocketBase `app_assistant_usage`, or an in-memory ring buffer), and `GET /api/admin/assistant-usage` for Admin → Ask usage. See below |
| `limits.js` | The provider's limits and paid prices, one profile per provider and key tier, with env overrides |

**Settings** (env only; switching provider needs no code change, only a restart):

| Variable | Meaning |
|---|---|
| `ASSISTANT_PROVIDER` | `goedel` or `anthropic`. Unset: `goedel` when a Gödel key is set, else `anthropic` when `ANTHROPIC_API_KEY` is set, else Ask is off ("not set up yet"). Set to a provider whose key is missing: Ask is off |
| `GOEDEL_API_KEY` | Gödel Machines key (`sk-gm-free-…` or `sk-gm-paid-…`). `GODEL_API_KEY` is accepted too; `GOEDEL_API_KEY` wins when both are set |
| `ANTHROPIC_API_KEY` | Anthropic key (locally also `anthropicApiKey` in `data/supabase_config.json`) |
| `ASSISTANT_MODEL` | Model override. Defaults: `deepseek/deepseek-v4.1-flash` (goedel), `claude-haiku-5-5` (anthropic) |
| `ASSISTANT_BASE_URL` | OpenAI-compatible base URL for the goedel provider. Default `https://api.goedelmachines.com/v1` |
| `ASSISTANT_MAX_CONCURRENCY` | Calls in flight to the provider from one server process; more wait in a queue (up to 30 waiting, 45 s). Default 2 for goedel (the free tier allows 2 in flight; a paid key allows 8), unlimited for anthropic. `0` = unlimited |

To switch back to Claude: set `ASSISTANT_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`, then restart. Never put a key in HTML or client JS, and never log it.

**What users see on errors:** 401/403 → "The assistant key is not valid. Ask the administrator to check it." (503 `not_configured`); 402 (paid balance used up) → "The assistant has run out of credit…" (503 `no_credit`); 429 after the retry → "The assistant is busy. Try again in a moment." (429 `busy`); 400/413 → `bad_request`; no answer in 60 s → 504 `timeout`; anything else → 502 `upstream`.

**Logs:** one line per call: provider, model, latency (and queue wait), stop reason, input / output / cached / reasoning tokens, `X-Data-Policy`, retries. Never the conversation, never the key. Example: `[Assistant] goedel deepseek/deepseek-v4.1-flash ok 1450 ms stop=tool_use in=3400 out=120 cached=3072 reasoning=60 data-policy=retained`.

**Data policy:** a free Gödel key (`X-Data-Policy: retained`) stores prompts and answers and may use them for training: questions, the office scope line and the aggregate tool results (counts per office, loss percentages) are sent. A paid key (`sk-gm-paid-…`, `X-Data-Policy: none`) keeps nothing. The model runs in India (Hyderabad).

## Usage tracking (Admin → Ask usage)

**Admin → Ask usage** (`admin_users.html?tab=asks`, also `?tab=ask` and **Ask usage** in the shell's Administration group and ⌘K) shows how much Ask is used and how close today is to the provider's limits.

- **Recording** (`lib/assistant/usage.js`): `index.js` calls `onUsage` after every model call that was not aborted, success or failure; `server.js` adds who asked and the `turn` (0 = the call that starts a question, then 1, 2… for the calls after its tool results). One row per call: user email and name, provider, model, turn, input / cached input / output / reasoning tokens, latency, status (`ok`, the HTTP status, or `timeout`, `queue`…), tool calls, retries and `X-Data-Policy`. **Never the question, the answer or tool results.** Tokens are normalised: `input_tokens` includes the cached part (OpenAI-compatible `prompt_tokens` already does; Anthropic's `input_tokens` does not, so its cache reads and writes are added), `output_tokens` includes reasoning. The cached count is `prompt_tokens_details.cached_tokens` (or DeepSeek's `prompt_cache_hit_tokens`), reasoning `completion_tokens_details.reasoning_tokens`, Anthropic's cache `cache_read_input_tokens`.
- **Where:** PocketBase `app_assistant_usage` when `PB_URL`, `PB_SUPERUSER_EMAIL` and `PB_SUPERUSER_PASSWORD` are set (the VM; collection in [users.md](users.md#app_assistant_usage), migration `1794200000`), written in the background in batches of up to 100 about once a second. A write or read failure never affects Ask: it is logged at most every 10 minutes and the rows stay in memory. Every row is also kept in an in-memory ring buffer of the last 2,000 calls, which the panel reads without PocketBase (local, Vercel; per process, empty after a restart) or when PocketBase cannot be read (the panel says so).
- **API:** `GET /api/admin/assistant-usage?range=today|7d|30d` (admins only, the same check as `/api/admin/sources-info`; cached 15 s, `&refresh=1` reads again). Days are UTC days, like the provider's daily limits (they reset at 00:00 UTC = 05:30 IST). Answer: `totals` (calls, questions = calls with `turn` 0, users, input / cached / new input / output / reasoning tokens, tool calls, errors and `errorsByCode`, `latency.p50` / `p90` of answered calls), `errors` (code, label, count), `today` (`newInput` and `output` as `{ used, limit, pct }` against the daily limits, `rpm` and `inputPerMinute` as the busiest minute today `{ peak, at, limit, pct }` counting retries, `requests`, `resetsAt`), `series` (per hour of today labelled in IST for `today`, per UTC day otherwise: calls, questions, tokens, errors), `topUsers` (top 10 by questions, then tokens), `provider` (provider, model, key tier, latest `X-Data-Policy`, note), `limits`, `cost` (the range's tokens at the paid prices, with GST; `null` without prices), `source` (`pocketbase` or `memory`).
- **Limits and prices** (`lib/assistant/limits.js`, one profile per provider and key tier):

| Profile | RPM | New input / min | New input / day | Output / day | Prices (₹ per million) |
|---|---|---|---|---|---|
| Gödel free key (`sk-gm-free-…`) | 60 | 100K | 10M | 1M (reasoning counts) | input 12, cached 0.25, output 50, + 18% GST (for "cost if paid") |
| Gödel paid key (`sk-gm-paid-…`) | no cap set | no cap set | no cap set | no cap set | the same |
| Anthropic | no cap | no cap | no daily cap | no daily cap | none unless set |

  Cached input does not count toward the new-input allowance. Env overrides (`0` or `none` = no cap): `ASSISTANT_LIMIT_RPM`, `ASSISTANT_LIMIT_INPUT_MINUTE`, `ASSISTANT_LIMIT_INPUT_DAY`, `ASSISTANT_LIMIT_OUTPUT_DAY`; prices `ASSISTANT_PRICE_INPUT`, `ASSISTANT_PRICE_CACHED`, `ASSISTANT_PRICE_OUTPUT` (₹ per million tokens), `ASSISTANT_PRICE_GST` (a fraction, `0.18`); `ASSISTANT_TIER` (`free` | `paid`) when the key prefix does not tell.
- **The tab:** range switch (Today / 7 days / 30 days); tiles for questions, model calls, users, input tokens (new and cached), output tokens, errors and median latency; "Today vs free-tier daily limit" bars for new input and output (amber from 70%, red from 90%, "No daily cap" for Claude) with the busiest minute against the RPM and per-minute input limits; tokens or requests per hour / day; errors by code; top users; and a note with the provider, model, key tier, data policy and the estimated cost if paid.

**Tests:** `node vm/dev/test-assistant-usage.js` (token mapping for both providers, turn, status, the ring buffer, limits and overrides, the aggregation with daily-limit percentages and cost, the admin route; with a PocketBase binary also the migration and the PocketBase path on a throwaway instance with a copy of the migrations). `node vm/dev/test-assistant-provider.js` (no network: translation both ways over a multi-turn tool loop, malformed arguments, stop reasons, retries, errors, the gate, the settings, the Anthropic path with a mocked client and server.js end to end against a local mock). `node scripts/qa/assistant-live.js --env <file>` asks 15 typical questions of the configured model and checks the tool, report, view, office and `group_by` it picks, answering every tool call with made-up offices and numbers (safe on a free key), plus latency and tokens.
