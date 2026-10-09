# Label packs

A label pack is a small JSON file that makes a domain speak your product's language. Load it from **Data → Load a label pack**. It changes names and the starter checklist only: your traces, notes, labels, patterns and judges are untouched, and **Remove it** brings the built-in names back.

Every field is optional. Include only what you need.

```json
{
  "name": "Shop help",
  "description": "A chat assistant that answers shoppers' questions about orders, returns and refunds.",
  "flags": {
    "said_done_not_done": "Says done, but nothing was done",
    "reply_cut": "The reply was cut short"
  },
  "kinds": {
    "message": "Customer message",
    "alert": "Alert we sent"
  },
  "proactiveKinds": ["alert"],
  "starterFailureModes": [
    {
      "name": "Wrong order",
      "definition": "Answers about a different order from the one asked about.",
      "boundaries": "In: any mix-up between two orders. Out: the right order with a wrong detail."
    }
  ],
  "goodPatternHints": ["Asks one clear question when something is missing"],
  "reviewGoal": 100
}
```

| Field | What it does |
|---|---|
| `name` | The domain's name in the menu and on every page. |
| `description` | What your product is, in a sentence or two. Sent with your notes when they are grouped, so the patterns fit your product. |
| `flags` | A readable label for each warning flag on your traces. Without one, `said_done_not_done` is shown as "said done not done". |
| `kinds` | A readable label for each `kind` on your traces. |
| `proactiveKinds` | Kinds where your product spoke first (a reminder, an alert), so there is no user message to show. |
| `starterFailureModes` | Your own checklist of common failures, shown at the bottom of the Patterns tab as a prompt. |
| `goodPatternHints` | Examples of good behaviour, used as hints when grouping. |
| `reviewGoal` | How many reviewed conversations the progress bar counts towards. |
| `codeFaultFlags` | Flags that mean plain code, not the AI, caused the problem. Used when suggesting how to handle a pattern. |
| `dimensions`, `labels`, `testExpected` | Advanced: values for synthetic cases, the words used for "trace" and "user", and the expected answers a test case can carry. |

Anything else in the file is ignored. A pack travels with **Data → Download a backup**, so a colleague who restores your backup sees the same names.

The pack stays where the rest of your work is: in your browser, or in `evaldesk-data` in local mode. Nothing is uploaded.
