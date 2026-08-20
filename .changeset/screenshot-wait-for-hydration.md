---
"@buildinternet/uploads": minor
---

`screenshot` gains `--wait-for <js>` (local backend), a hydration-aware gate that polls a JS expression in the page until truthy before `--eval` and capture (issue #715). The `load`/`networkidle` settle strategies fire before a React/Next app hydrates, so a synthetic `el.click()` in `--eval` hit the still-inert server-rendered DOM with no handler attached — silently doing nothing. Expressing the app's own "interactive" signal (e.g. `--wait-for 'window.__hydrated===true'`) closes that gap; a predicate that never becomes truthy fails with `RENDER_FAILED` instead of capturing the un-ready page. `--wait-for` is local-only (rejected up front on `--via remote`, like `--eval`). `--eval`/`--wait-for` help and the CLI docs now warn that synthetic events won't reach framework handlers until hydration.
