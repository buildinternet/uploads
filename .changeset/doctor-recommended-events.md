---
"@buildinternet/uploads": minor
---

`uploads github doctor` now reports `issue_comment` as a recommended (non-gating) webhook event subscription. When the GitHub App is otherwise healthy but not subscribed to `issue_comment`, doctor prints a `note:` line and still exits 0 — required events (`issues`, `pull_request`) are unaffected. `--json` output gains `recommendedEvents` and `missingRecommendedEvents`; older servers whose health payload predates these fields are handled gracefully.
