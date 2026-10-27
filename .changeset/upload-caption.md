---
"@buildinternet/uploads": minor
---

Add `--caption <text>` (and a `caption` MCP field) to say what a shot shows, e.g. `uploads put ./empty.png --pr 12 --caption "Empty state after deleting the last project"`. `caption` is a canonical metadata key of up to 140 characters; the PR comment shows it as plain text under the image, before the screen, path and state labels. `description=` warns as a near-miss of `caption`.
