# The traces file

A traces file is a JSON list with one object per conversation (or per turn you want reviewed). Any product can produce one; EvalDesk does the rest.

Only `id`, `input` and `output` are required.

```json
[
  {
    "id": "pay-001",
    "kind": "message",
    "at": "2026-09-01T09:30:00Z",
    "person": "Merchant 12",
    "group": "Store 3",
    "release": "v1.2",
    "input": { "label": "Merchant", "text": "When do payouts come through for my store?" },
    "context": [{ "who": "Merchant", "text": "an earlier message" }],
    "steps": [
      { "section": "reasoning", "label": "Reasoning", "text": "I'll look up the payout schedule." },
      { "section": "tool", "label": "Look up the payout", "fn": "get_payout", "request": "next payout", "text": "weekly, Fridays", "short": "looked up the payout", "seconds": 0.8, "cost": 0.0004, "error": false }
    ],
    "output": { "label": "Assistant", "text": "Payouts run weekly on Fridays.", "detail": "" },
    "summary": "Looked up the payout → answered",
    "metrics": { "latency": 8.2, "cost": 0.012, "tokens": 3100, "steps": 2, "replyChars": 240 },
    "flags": ["status_mismatch"],
    "dims": { "kind": "message", "role": "merchant", "channel": "chat" },
    "meta": "Anything else worth seeing while reviewing"
  }
]
```

| Field | What it is |
|---|---|
| `id` | **Must stay the same every time you export**, or your notes come loose from their conversations. |
| `input`, `output` | What the user asked and what the product replied. Each is `{ label, text }`, or just a string. |
| `context` | Earlier turns, shown folded above the input and labelled "Earlier message". Each has `who` and `text`; add `at` to show when it was sent. The input is then labelled "This message". |
| `steps` | What happened in between. `section` is `"reasoning"` or `"tool"` (the default). A tool step can show what it was asked (`request`) and what it returned (`text`). `fn` is the function name, shown in brackets. `short` is the one-line version shown when the section is closed. Optional on any step: `seconds` (how long it took), `cost` (in US dollars) and `error` (`true` when the step failed). With these, the page marks the slowest and most costly step, shows a failed step in red, and can check whether the reply dealt with the failure. |
| `kind` | The type of interaction, e.g. `message` or `alert`. Used for filters and for comparing like with like. |
| `at` | When it happened (ISO date). Used for ordering and for Trends. |
| `release` | Optional. The product version that produced this conversation. If you leave it out, add releases by date on the Trends tab. |
| `metrics` | Any of `latency` (seconds), `cost` (US dollars), `tokens`, `steps`, `replyChars`. Unusually high values get a chip. |
| `flags` | Warnings your own code has already raised. Give each a readable label under `flags` in the domain pack. EvalDesk tells you when a flag already catches a failure pattern, so you don't need an AI judge for it. |
| `dims` | Tags to filter and sample by: role, channel, region, anything. |
| `summary`, `meta`, `person`, `group` | Shown while reviewing. |

## What the automatic checks read

The automatic checks run on every trace as soon as it is loaded, with no AI. The more of these you include, the more they can tell you:

| Check | Needs |
|---|---|
| Tool failures handled | `error: true` on any step that failed |
| Figures come from a source | `steps` with the tool results in `text` (and `request`) |
| Speed, Cost | `metrics.latency`, `metrics.cost` |

## Before you load a file

**Remove names, contact details and anything else personal.** EvalDesk shows exactly what it is given, and the AI features send parts of it to a model (see Privacy in the README).

## Loading a newer file

Load the newer export from **Data → Load a traces file**. Notes, labels, judges and test cases are kept, matched by `id`.
