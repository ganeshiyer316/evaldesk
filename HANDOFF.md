# Handoff

Read this first if you are picking the project up (person or AI tool). Keep it current: what was done, what is open, what is not deployed.

## What this is

EvalDesk: an open-source review desk that lets subject-matter experts review an AI product's conversations, find failure patterns, build LLM judges and keep test cases. Owner: Ganesh Iyer. Plain JavaScript, no dependencies, Node 22+.

## Rules

1. **Demo and test data must be fictional.** Never add real conversations, names or phone numbers. A test (`test/engine.test.js`, last case) fails if names from the private product this grew out of appear anywhere.
2. **Ask Ganesh before anything public:** creating or publishing the repository, the hosted site, the licence, posts.
3. **Commits** are authored as `Ganesh Iyer <68853037+ganeshiyer316@users.noreply.github.com>` with a `Co-Authored-By:` trailer for any AI. No model names in commit messages.
4. **Never ask for API keys in chat.** Keys go in `.env` (local mode) or in the visitor's own browser (Settings).
5. **AI calls go only to zero-data-retention providers** (`site/core/openrouter.js` is the only place that calls a model), and the user can see exactly what is sent (preview and log).

## State on 2026-10-07

**Not public. Not deployed.** The code lives only in a local folder with a local Git history. No GitHub repository, no hosted site, no licence file yet.

Done:

- Shared engine (`site/core/engine.js`) that runs in the browser (IndexedDB) and behind the optional local server (files). `site/backend.js` picks one.
- All six tabs working in the browser with no server: Review, Patterns, Grid, Judges, Test cases, Trends.
- New for the standalone tool: load a traces file, add traces, backup and restore, delete; Settings (OpenRouter key in the browser, models); "see what is sent" preview and log; releases added by hand, from a `release` field on traces, or from git tags in local mode; filters built from whatever tags the traces carry; a General pack.
- Demo data: 40 fictional conversations each for Payments and Healthcare, part-reviewed (`scripts/demo/*.mjs` → `npm run demo` → `site/demo/*.json`).
- 33 tests passing (`npm test`).
- Checked by hand in a browser with the Payments demo: every tab renders, dialogs open, a verdict survives a reload. Local mode checked through its API with the Healthcare demo.

## Open

- **Not tried with a real OpenRouter key.** Grouping and judges are covered by tests with a fake model, and worked in the tool this was extracted from, but nobody has run them from a browser against OpenRouter yet. Ganesh should add a key in Settings and try "Group my notes now" and one judge run on the demo.
- **Decisions for Ganesh:** licence (MIT suggested), who creates the public repository, whether the README should credit the evals course by name.
- **Before publishing:** add the licence file; a GitHub Pages workflow that publishes the `site/` folder; a screenshot in the README; replace `<this repository>` in the README with the real address.
- The judge results inside the demo are sample numbers, labelled as such in the version note. With only one failing example in the tuning set they show a wide "likely range", which is honest but thin.
- Narrow screens: the Review tab is laid out for a laptop or bigger. Not checked on a phone.
- A custom pack needs a file in `site/packs/` and its name in `site/backend.js`. There is no way to add one from the page yet.

## Parked ideas

Importers (OpenTelemetry, LangSmith, CSV); running a judge several times per trace (pass@k); synthetic test cases from a pack's dimensions; ready-made judges per pack; Google Sheets export; several projects per domain; linking test cases to CI.

## Map

| Path | What |
|---|---|
| `site/` | Everything the browser loads. This folder is the hosted site. |
| `site/core/` | The logic: `engine.js` (actions, snapshot, exports), `patterns.js` (grouping), `judges.js`, `tasks.js` (test cases), `stats.js`, `openrouter.js`, `sha256.js`. |
| `site/app.js`, `backend.js` | The page, and where its data lives. |
| `site/packs/`, `site/demo/` | Domain packs and the built demo files. |
| `scripts/server.mjs` | `npm start` (local mode) and `npm run site` (page only). |
| `scripts/build-demo.mjs`, `scripts/demo/` | The demo scenarios and their builder. |
| `docs/` | User guide and the trace format. |
