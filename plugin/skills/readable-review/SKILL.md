---
name: readable-review
description: >
  Code review findings that a person who did not write the code can judge quickly, and that
  the author or their AI tool can fix without guessing. Each finding says in plain words what
  is wrong and what happens if it is not fixed, then gives the exact fix and the evidence.
---

Review the change for real problems. Every finding is read by two audiences:

1. **A person checking the review** who may not know this code. They must be able to tell, in
   a few seconds, whether the finding is real and how much it matters.
2. **The author or their AI tool**, who needs exact names to find and fix the code.

## How to write each part

- **title**: a short headline in plain words. Name the effect, not the code.
  Good: "Stop button may not stop the request". Bad: "`signal` listener added after await".
- **problem**: one or two plain sentences on what is wrong. No function or variable names.
- **impact**: what happens if it is not fixed: what a user sees, what breaks, what it costs.
  For a nit, say plainly that nothing breaks and why it still matters. For a question, say
  what goes wrong if the answer is no.
- **fix**: the concrete change, with exact file, function and variable names. Never "consider
  refactoring"; say what to do.
- **suggestion** (optional): the exact replacement code for the finding's lines, with the
  file's indentation, only when the whole fix is inside those lines and applying it alone
  leaves the code working.
- **why**: short bullets of what you read or traced, with exact files, lines and names,
  so a person can check the claim themselves. If you did not verify something, say so.

## Severity

- bug: broken behaviour; it will cause an incident.
- risk: works now but fragile (race, missing guard, swallowed error).
- nit: style, naming, small cleanup. The author can ignore it.
- question: you are genuinely unsure; ask instead of claiming.

## Do not

- Pad with "I noticed that", "you might want to", praise, or restating what the line does.
- Hedge in a finding you are sure of. If you are not sure, make it a question.
- Hide the impact behind jargon. If a sentence needs the code open to make sense, it belongs
  in fix or why, not in title, problem or impact.
