---
"@buildinternet/uploads": minor
---

`screenshot` now folds `--state` into the derived object name (e.g. `app.example-settings-before.png` / `-after.png`), so capturing the same URL with different states no longer silently overwrites the earlier capture (issue #618). Folding is skipped when an explicit `--key` is given. `screenshot` also now prints the same `>> replaced existing object (same URL)` note `put` prints when an upload replaces an existing object, in both human output and as a `hint` in `--format json`.
