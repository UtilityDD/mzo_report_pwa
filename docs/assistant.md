# Ask (assistant)

The question box that answers with numbers and opens filtered reports.

## Assistant (Ask)

`assistant.html` (shell item **Ask**, and **Ask: …** in ⌘K) answers questions and opens reports already filtered. Model: Claude Haiku (`claude-haiku-5-5`, effort `low`) through `POST /api/assistant` in `server.js` using `@anthropic-ai/sdk`.

- **Key:** set `ANTHROPIC_API_KEY` on the Vercel project (locally: env var or `anthropicApiKey` in `data/supabase_config.json`). Without it the route returns `503 not_configured` and the page says so. Never put the key in HTML.
- **Who runs what:** the route only holds the key, fixes the model / system prompt / tools, validates the conversation (≤ 60 messages, ≤ 200 KB, user/assistant only) and rate-limits per user. The **browser** runs the tools: `query_report` counts NSC, load extension, solar and loss from the DataHub cache after `MzoScope.filterRows`, so answers respect the login scope and only aggregates (no names / phones) are sent to the model; `open_report` turns a report + filters + view into a link button; `get_briefing` reads `/api/executive/briefing`.
- **Catalogue:** `lib/assistant_catalog.js` (shared by server and browser) lists every report, its URL filters (`region`, `division`, `ccc`, `q`) and named views (e.g. `nsc.over_30_days` → `kpi=delay30`). When a page gains a deep-link parameter, add it there. To make another report answerable, add an adapter in `assistant.html` and set `data: true`.
- The conversation (including the model's thinking blocks, passed back unchanged) lives in `sessionStorage` (`mzo_assistant_v1`); **New chat** clears it.
