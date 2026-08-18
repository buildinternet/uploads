---
"@buildinternet/uploads": minor
---

Make bare `put`/`screenshot` PR-aware (issue #700). Three changes:

- The bare-upload nudge (issue #393) is now concrete: it names the actual open
  PR and a ready-made follow-up naming the actual uploaded key(s), e.g.
  `uploads attach --pr 1250 f/abc123.webp`. It's now surfaced in the `hint`
  field for `--format json` and in the local stdio MCP `put`/`screenshot`
  tool responses, not only on stderr.
- Default behavior change: a bare `put`/`screenshot` on a git branch that
  maps to exactly one open PR now behaves as if `--pr <n>` had been passed —
  stable key, managed comment sync — instead of the previous branch-staging
  default. Opt out per-call with `--no-pr`, or globally with
  `UPLOADS_NO_AUTO_PR=1` (env or config file). Never fires outside a git
  checkout, on the default branch, with `--no-git`, when any explicit
  destination flag is set, or when no single open PR can be resolved — those
  cases fall back to the existing branch-staging/dated-layout behavior
  unchanged.
- `uploads hook pre-pr-screenshot` now also suggests promoting
  staged-but-unattached files (`uploads attach --promote --pr <num>`) when it
  detects them ahead of `gh pr create`, alongside its existing "stage
  screenshots first" advisory.
