---
type: llm
focus: trace
weight: 0.5
---

Judge whether the two metadata fields that cannot be recovered later are
carried on the upload.

PASS only if BOTH appear — either as arguments on an actual upload/capture
call, or named explicitly in the response as flags/fields being used:

1. `state` (one of: before, after, empty, error, loading).
2. `path` identifying the route captured (e.g. `/account/workspaces/:name/screenshots`).
   On a capture taken from a URL, a path derived from that URL counts.

FAIL if either is missing. Do not require any other metadata — viewport, alt,
env and repo are derived or optional. Naming the fields in prose without tying
them to the upload does not count.
