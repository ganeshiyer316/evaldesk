# Handoff

Read this first if you are picking the project up (person or AI tool). Keep it current: what was done, what is open, what is not deployed.

## What this is

EvalDesk: an open-source review desk that lets subject-matter experts review an AI product's conversations, find failure patterns, build LLM judges and keep test cases. Owner: Ganesh Iyer. Plain JavaScript, no dependencies, Node 22+.

## Rules

1. **Demo and test data must be fictional.** Never add real conversations, names or phone numbers. A test (`test/engine.test.js`, last case) fails if names from the private product this grew out of appear anywhere.
2. **Ask Ganesh before anything public:** creating or publishing the repository, the hosted site, the licence, posts.
3. **Commits** are authored as `Ganesh Iyer <68853037+ganeshiyer316@users.noreply.github.com>` (this address is what makes them count on his GitHub contribution graph; don't change it) with a `Co-Authored-By:` trailer for any AI. No model names in commit messages.
4. **Never ask for API keys in chat.** Keys go in `.env` (local mode) or in the visitor's own browser (Settings).
5. **AI calls go only to zero-data-retention providers** (`site/core/openrouter.js` is the only place that calls a model), and the user can see exactly what is sent (preview and log).

## 2026-10-09: first run on a real traces file

- The conversation list can be sorted newest or oldest first (menu above the list, remembered in the browser).
- Tried the automatic checks on a real file of 253 conversations whose tool steps record only a one-line summary of each result. "Figures come from a source" failed 131 of them, all false alarms. It now stands aside ("doesn't apply") when a tool worked but nothing recorded for any tool contains a figure. A figure with no working tool behind it still fails, so both demos give the same results as before.
- A check that applies to no conversation in the file is left out of the checks table and named underneath with the reason (for example "no cost is recorded").
- **Label packs from the page** (Data → Load a label pack; fields in `docs/label-pack.md`): a reviewer's own product name, readable names for warning flags and kinds, and a starter checklist, laid over the built-in pack for that domain. Stored with the rest of the domain's work (a new `pack` document), included in backups, removable. `checkPack` in `site/core/engine.js` keeps only known fields of the right shape.
- 35 tests passing. Checked in a browser with made-up data: sort, the shorter checks table, a loaded pack renaming the domain, its flags and its kinds.
- Earlier turns are labelled "Earlier message · who" (with the time when a turn has `at`) and the input "This message · …" when there are earlier turns. A first-time reviewer had read an earlier turn as part of the message being judged.
- **Around this time** (2026-10-10): under "What happened", a conversation lists the same person's other conversations within three minutes, oldest first, each a link (`nearbyTraces` in `site/core/stats.js`). It needs `person` or `group` and `at` on the traces, and shows nothing when there is nothing nearby. Reason: a reviewer judged a reply as wrong when the real cause was two more messages sent seconds apart, each its own trace.
- **First real grouping run timed out** (2026-10-10): 55 notes on 22 conversations, `moonshotai/kimi-k3`, no reply within the 2-minute limit. The limit for grouping is now 5 minutes and the message names the model and points to Settings. Not confirmed fixed: nobody has yet seen a grouping finish against real OpenRouter. If slow models keep timing out, stream the reply and time out on silence instead of total time.
- **Second real grouping run returned "no patterns"** (2026-10-10, `deepseek/deepseek-v4.1-flash`, 55 notes). The old code threw away any answer it could not read whole and said only "no patterns". Now: a cut-off answer still yields the patterns that arrived complete, with a warning that the grouping is incomplete (`salvageArray`, `parseGrouping` in `site/core/patterns.js`); other spellings of the list names are accepted; and when nothing can be read the message says why (empty answer, used up on thinking, cut off, or wrong form with the first 140 characters). `chat` now returns `finish` and `thought`. Still not seen working against real OpenRouter.
- **Visitors were running old code after a release** (found 2026-10-10: a reviewer kept seeing an error message the published code could no longer produce). GitHub Pages lets browsers keep each file for 10 minutes, the site is a dozen scripts that load each other, and an open tab never reloads. Fix: at publish time `scripts/stamp-version.mjs` adds `?v=<commit>` to every script address and writes `version.json`; the page shows its version in Settings and, when `version.json` is newer than the page, shows "A newer version of EvalDesk is out… Reload to get it" (checked on opening, on returning to the tab, and every 5 minutes). Run from the files, the version is `dev` and nothing is checked. Checked in a browser on a stamped copy.
- **Cause of the failed groupings found** (2026-10-10): `deepseek/deepseek-v4.1-flash` spent its whole answer limit on thinking and wrote nothing; `moonshotai/kimi-k3` most likely did the same until the time limit (that one run cost $0.22). Now every call asks for light thinking (`reasoning: { effort: 'low' }`), an empty answer gets one more try with twice the room, grouping has 16,000 tokens of room (was 8,000), a judge's verdict 2,000 (was 700) and a judge-prompt rewrite 8,000 (was 4,000). A judge that gets an empty answer now says so. Judges had the same weakness and would have failed on first use. Not yet seen working against real OpenRouter; if a provider rejects the thinking setting it will show as an HTTP error naming it.
- **First complete real grouping** (2026-10-10): 57 notes on 23 conversations, `deepseek/deepseek-v4.1-flash`, 8 failure patterns, no cut-off warning, after the light-thinking and extra-room changes. That model is now the default for grouping (it already was for judges). Judges have still not been run with a real key.
- Seen in that first real use, not yet acted on: (1) the model's "likely fix" and "suggested handling" are stated as fact but are guesses, since it cannot see the product's code; (2) the same note text on two parts of one conversation looks like a duplicate in the Patterns list, because the part is not shown; (3) one incident spread over six quick-fire conversations counts as six in a pattern's prevalence.
- Open: a loaded pack renames one of the three built-in domains; there is still no way to add a fourth domain from the page.

## State on 2026-10-07

**Public repository and hosted page.** The code is at https://github.com/ganeshiyer316/evaldesk (MIT, open source, decided by Ganesh on 2026-10-07). The page is published at https://ganeshiyer316.github.io/evaldesk/ by `.github/workflows/pages.yml`: every push to `main` runs the tests and then publishes the `site/` folder, so **anything pushed to `main` goes live**.

Done:

- Shared engine (`site/core/engine.js`) that runs in the browser (IndexedDB) and behind the optional local server (files). `site/backend.js` picks one.
- All six tabs working in the browser with no server: Review, Patterns, Grid, Judges, Test cases, Trends.
- New for the standalone tool: load a traces file, add traces, backup and restore, delete; Settings (OpenRouter key in the browser, models); "see what is sent" preview and log; releases added by hand, from a `release` field on traces, or from git tags in local mode; filters built from whatever tags the traces carry; a General pack.
- Automatic checks (`site/core/checks.js`): four rules that run on every trace with no AI (failed tool ignored, figures not from a source, speed, cost). Results show as pills on each conversation and as a table when the Review tab opens; a failed check is also a warning flag. Steps can carry `seconds`, `cost` and `error`.
- A plain one-line explanation under each tab, and the likely cost of a judge run shown before running it (worked out from that judge's earlier runs).
- Demo data: 40 fictional conversations each for Payments and Healthcare, part-reviewed (`scripts/demo/*.mjs` → `npm run demo` → `site/demo/*.json`).
- 33 tests passing (`npm test`).
- Checked by hand in a browser with the Payments demo: every tab renders, dialogs open, a verdict survives a reload. Local mode checked through its API with the Healthcare demo.

## Open

- **Not tried with a real OpenRouter key.** Grouping and judges are covered by tests with a fake model, and worked in the tool this was extracted from, but nobody has run them from a browser against OpenRouter yet. Ganesh should add a key in Settings and try "Group my notes now" and one judge run on the demo.
- **Decisions for Ganesh:** whether the README should keep crediting the evals course by name.
- The automatic checks are rules of thumb and will give some false alarms on real data (for example a correct figure the product knew from somewhere not in the trace). They have only been run on the demo data so far. Worth trying on a real traces file and tuning.
- The judge results inside the demo are sample numbers, labelled as such in the version note. With only one failing example in the tuning set they show a wide "likely range", which is honest but thin.
- Phones: there is a phone layout (one column, each conversation on its own screen, tabs scroll sideways), checked at phone size in a desktop browser. **Not tried on a real phone**, in particular selecting words to comment by touch.
- README screenshots are in `docs/images/`. Retake them from the Payments demo (`?demo=payments`) if the page changes much.

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
