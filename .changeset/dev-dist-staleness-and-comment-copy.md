---
"@buildinternet/uploads": patch
---

Warn on stderr when the linked dev CLI's `dist/` predates `src/` (or is missing), so testing a change against the linked `uploads` binary can no longer silently exercise stale compiled code — a false alarm that's bitten local debugging more than once. The check is a no-op for published npm installs (no `src/` tree ships in the tarball) and costs at most a couple of directory walks.

Also update the `put --comment` MCP tool description and the `comment` MCP tool description, which still described posting "via local gh auth" as the primary path — both now match the CLI's own help text: the server-side bot comment (`uploads-sh[bot]`) is tried first, with local `gh` as a fallback.
