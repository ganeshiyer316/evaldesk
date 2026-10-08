# EvalDesk: how to use it

EvalDesk is for reviewing your AI product's conversations. You write notes on what went wrong (open coding), the tool groups them into patterns (axial coding), and you build a check for each pattern and watch it over time.

## Getting started

1. Open the page and pick your domain in the menu at the top (Payments, Healthcare or General).
2. Click **Try the demo** to look around, or **Load your own traces file** (format: [trace-format.md](trace-format.md)).
3. For the two AI features (grouping notes and judges), open **⚙ Settings** and add an OpenRouter key. Give the key a small spending limit. Everything else works without one.

Your work is saved as you go. On the hosted page it lives in your browser, so use **Data → Download a backup** now and then. Clearing your browser's site data deletes it.

## Automatic checks: what you get before you do anything

The moment a file is loaded, EvalDesk runs a few plain rules on every conversation. No AI is used, no key is needed, and nothing is sent anywhere. The Review tab opens on a table of what they found, and **Show them** takes you to the conversations that failed.

- **Tool failures handled:** a tool call failed, and the reply carries on as if it worked.
- **Figures come from a source:** an amount, percentage, time or long number in the reply doesn't appear in any tool result or in anything the user said. Small everyday numbers ("5 to 10 days") are ignored.
- **Speed** and **Cost:** the conversation is among the slowest or costliest tenth *and* at least twice the typical one.

Each conversation shows its results as ✓ and ✕ pills under the summary, with the reason for any fail. A failed check also counts as a ⚑ warning, so you can filter by it, and the Patterns and Judges tabs will tell you when a check already catches one of your failure patterns.

These are rules of thumb. A fail means "look at this one", not "this is wrong": your verdict is the one that counts.

## The six tabs

**Review: read and note**

- **Left:** every conversation, in the order of your file.
  - Filter by kind, by any tag on your traces (role, channel and so on), and by warnings (⚑).
  - **Review next** picks one for you:
    - *one of each kind*: from the type of conversation you've reviewed least;
    - *random*;
    - *next in this list*: works through your current filter, e.g. all merchant questions.
- **Middle:** the conversation, as the user saw it.
  - **What happened:** a one-line summary. Each step shows how long it took and what it cost when your traces include that; the slowest and most costly steps are marked, and a failed tool call is shown in red.
  - **Chips:** outliers (slower than 90% of conversations) and warnings, e.g. "Says done, but the record says otherwise".
  - Then the conversation in four parts. Click a part's title to open or close it; the page remembers your choice for the next conversation (**Open all · Close all** at the top). A closed part shows a one-line gist, and 💬 with a number if it has comments.
    - 👤 **User:** the user's message (earlier messages tucked inside).
    - 🧠 **Reasoning (what it understood and decided):** the AI's reasoning steps, if your traces include them.
    - 🔧 **Tool calls (what code did):** each tool that ran, with what it was **asked** and what it **got**. Closed by default.
    - 💬 **Assistant:** the reply as the user saw it.

    Reasoning and Tool calls together tell you where a bad reply came from: the AI misread the request, a tool returned the wrong thing, or the reply ignored what the tool said.
  - Voice inputs have a box to tick when the transcript itself was wrong.
- **Comments, like Google Docs:** select any words (part of a sentence is fine) and click **💬 Comment**.
  - The words stay highlighted, and your comment sits in the margin beside them.
  - Add as many as you like, even overlapping ones on the same sentence.
  - Hover a comment to see its words; click highlighted words to find their comment.
  - The small 💬 at the top-right of each part comments on that whole part.
  - Write what's wrong *and* what should have happened; vague notes can't be grouped.
- **Right:** your verdict (👍 / 👎) and an overall note on the whole conversation (**N**).
- **Keys:**
  - **←/→** previous and next;
  - **R** review next;
  - **G/B** good or bad;
  - **N** overall note;
  - **⌘↵** save a note;
  - **Esc** leave a box.

**Patterns: group notes**

- Every 5 new notes, your notes are grouped automatically into **failure patterns** and **good patterns**. **Group my notes now** does it on demand.
- Each pattern shows its definition, boundaries (what's in and what's out), a likely fix, how to measure it, and every example. Each example's id opens that conversation **in a new tab**.
- **Correct it in place:**
  - **✓ Looks right** locks the pattern.
  - **✎ Edit** changes the name, definition or boundaries.
  - **Merge** combines it with another pattern.
  - **✂︎ Split** asks the next grouping to split it.
  - **💬 Feedback** adds an instruction for the next grouping.
  - **✕** on an example means "doesn't belong here".

  Corrections stick: later groupings keep them.
- A green banner appears when two groupings in a row found nothing new. That's saturation: you've probably reviewed enough for now.
- The starter checklist at the bottom lists failures common in this domain. Use it as a prompt, not a verdict.
- **How we'll handle it** (on every failure pattern). Pick one:
  - 🔧 **Fix it:** a clear bug or missing instruction. Fix it, then check Trends to see the rate drop after that release.
  - ⚙️ **Code check:** a simple rule can spot it, like a ⚑ warning. Cheap, and never drifts.
  - ⚖️ **LLM judge:** spotting it needs judgement. **Open in Judges →** takes you there.

  The page suggests one and says why. If a ⚑ warning already matches your labels, it says code check. **Make test cases from its examples** adds them to the Test cases tab.

**Grid: every pattern × every reviewed conversation**

- **●** means your notes put that conversation in that pattern.
- Click a cell to say yes (✓) or no (✕). Click again to go back to what your notes say.
- The bottom row shows each pattern's prevalence.
- Downloads:
  - the grid (CSV);
  - **failure modes** (Markdown: definitions, boundaries, prevalence, linked examples), a write-up you can share;
  - all notes (CSV).

**Judges: an AI checker per failure pattern**

A judge reads every conversation and answers Pass or Fail for one problem. You check it against your own labels first, so you know how far to trust it.

1. **Pick a failure pattern** on the left, then **Create a judge**. Your labels come from the Grid: ● or ✓ means fail; anything else on a reviewed conversation means pass. Aim for 20 of each; the page tells you how many more you need.
2. **The tool splits your labelled conversations for you:**
   - **examples** (shown to the judge);
   - **tuning** (used to improve it);
   - **final test** (locked until the end).

   A conversation never moves between sets, and new labels slot in automatically.
3. **Check the criterion,** one sentence that is true for a good reply, and edit it if needed. The first prompt (v0) is written from your pattern, your notes and the example set only.
4. **Run on the tuning set.** The scorecard shows two numbers, each with a likely range:
   - **Catches real failures**: of the conversations you failed, how many the judge also failed (the true negative rate).
   - **Leaves good replies alone**: of the ones you passed, how many it passed. The rest are false alarms (the true positive rate).

   Agreement is tucked away on purpose, because it misleads when failures are rare. The target is 85% on both; the dashed line marks it.
5. **Read the disagreements.** Each one opens in a new tab, with the judge's reasoning.
6. **Improve with AI** writes v1 from the disagreements and scores it straight away. The versions table shows ↑ and ↓. You can also edit the prompt yourself and save it as a new version.
   - **⚠ "quotes held-out conversations"** means that version copied a tuning or test conversation into its prompt, so its scores are flattering. Edit it out.
   - If three versions barely move, label more, try a stronger model, or split the pattern.
7. **Run the final test once,** on the version you trust most. It can't be run twice, because that would turn it into another tuning set.
8. **Run on all conversations** to see the judge's estimate of how common the problem is.

- **Code checks:** if a warning flag (⚑) already matches your labels, the page says so. A code check is cheaper than a judge and never drifts.
- **Downloads for Google Sheets** (File → Import): scores per version, and every verdict with the judge's reasoning.
- **See what was sent to the AI** lists every request, exactly as sent.
- **Model:** the default is `deepseek/deepseek-v4.1-flash` (zero data retention, about a cent per run). Change it per judge, or change the default in Settings (local mode: `EVALDESK_JUDGE_MODEL` in `.env`).

**Test cases: checks you re-run after every change**

A test case is one conversation turned into a check: the message, what the product already knew, and a rule for what counts as a pass.

- **Make one:** **＋ Make a test case** on the Review tab (right-hand panel), or **Make test cases from its examples** on a pattern.
- **Two kinds:**
  - **Regression:** the product gets it right today and must keep getting it right. Good conversations start here.
  - **Capability:** the product gets it wrong today. It's a goal, so it's fine that it fails for now. Bad conversations start here.
- **Edit it:** the pattern, who checks it (you, a code check, a judge, or an exact answer), what the product already knew, and the "Pass if…" rule.
- **After a change**, try the message again (or run the evals) and click **✓ Passes now** or **✕ Fails now**. The top line shows the pass rate for each kind. When a capability case passes, **Move to regression** so it stays fixed.
- The page warns when every case is a regression case: a set that always passes can't show progress.
- **Downloads:**
  - test cases (CSV, for Google Sheets);
  - JSONL, for any eval runner.

**Trends: is it getting better?**

- Each pattern's rate per release of your product. Add releases with their dates at the bottom of the tab, or put a `release` field on your traces.
- **↓** means it dropped after that release.
- Review a fresh sample every week.

## Where things are saved

- **In the browser (the hosted page, or `npm run site`):** in that browser's own storage. Nothing is uploaded. **Data → Download a backup** gives you one file with everything for a domain; **Restore** loads it in another browser.
- **Local mode (`npm start`):** as files in `evaldesk-data/`, which Git ignores.

## What the AI features send

- **Grouping** sends your notes, the words you quoted, and the first 200 characters of each noted conversation's input. **See what is sent** on the Patterns tab shows the exact text before anything goes.
- **Judges** send the judge's prompt and one conversation at a time (up to 4,000 characters).
- Both go only to OpenRouter, using your key, and only to providers with zero data retention.
