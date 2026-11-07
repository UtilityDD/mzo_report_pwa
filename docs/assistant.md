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

**Tests:** `node vm/dev/test-assistant-provider.js` (no network: translation both ways over a multi-turn tool loop, malformed arguments, stop reasons, retries, errors, the gate, the settings, the Anthropic path with a mocked client and server.js end to end against a local mock). `node scripts/qa/assistant-live.js --env <file>` asks 15 typical questions of the configured model and checks the tool, report, view, office and `group_by` it picks, answering every tool call with made-up offices and numbers (safe on a free key), plus latency and tokens.
