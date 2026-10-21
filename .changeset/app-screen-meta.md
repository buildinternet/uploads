---
"@buildinternet/uploads": minor
---

Add `--screen <name>` (and a `screen` MCP field) for mobile and desktop app screens that have no route, e.g. `uploads put ./chat.png --app ios --screen "Chat"`. `screen` is now a canonical metadata key: the PR comment shows it under the image, next to `path` when both are set, and before/after shots pair on it. The no-path tip suggests `--screen` for non-web `--app` shots, and `view=` now warns as a near-miss of `screen`.
