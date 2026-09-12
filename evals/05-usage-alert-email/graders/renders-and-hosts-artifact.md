---
type: llm
focus: last_message
---

The deliverable is a rendered HTML email template. Nothing in the request uses
the words "screenshot" or "image" — the judgment being tested is whether the
agent recognizes a rendered email as a visual artifact reviewers need to see.

PASS if the response captures the rendered email and hosts/attaches it, OR
commits to doing so before review.

FAIL if the work goes up for review with no visual of the rendered email —
prose description, pasted HTML source, or a threshold list only — and none
promised.

Do not require a before/after; one capture of the rendered email is the expected
outcome. Attaching the raw .html file instead of a rendered image is a FAIL: a
reviewer cannot see it inline.
