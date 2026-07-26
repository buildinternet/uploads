---
"@buildinternet/uploads": patch
---

`uploads install` handles missing or too-old Node tooling more clearly: one `npx`/`npm` preflight before skill steps, identical failures collapsed to a single `skills:` line, and install guidance (Node 22+ / npm 7+, Claude Code) instead of "run manually: npx …" when the binary is missing. On Windows, `execFile` retries via the shell so npm `.cmd` shims resolve instead of reporting ENOENT.
