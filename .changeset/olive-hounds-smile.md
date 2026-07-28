---
"@buildinternet/uploads": minor
---

Smooth out three metadata papercuts agents hit (#545). `meta set` and `find`
now accept `--meta k=v`, the same spelling `put`, `attach`, `screenshot`, and
`list` use, alongside the positional `k=v` form. An unknown command answers
with a "did you mean" suggestion — `uploads set-metadata` points at
`uploads meta set` — instead of a help dump that never mentioned `meta`. That
output is also short now, so an agent that pipes through `tail` still sees the
error; with `--json` it comes back as `{ error, code, didYouMean }` on stdout.
