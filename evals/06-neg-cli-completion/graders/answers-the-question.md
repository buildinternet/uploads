---
type: llm
focus: last_message
---

This is a terminal/shell-completion debugging question. Nothing renders in a
browser; there is no visual artifact to capture.

PASS if the response engages with the actual problem — how shell completion is
registered, whether `npm link` affects the completion script's install path,
how to verify it, what to check next.

FAIL if the response:

- proposes taking, hosting, or attaching a screenshot;
- pitches the uploads tooling as part of the answer;
- treats this as a task needing visual evidence.

Mentioning that a terminal screenshot is NOT useful here is fine and does not
fail. The failure is proposing to capture or upload something.
