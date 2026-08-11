---
"@buildinternet/uploads": minor
---

CLI workspace-scoped `github/comment`, `github/promote`, `github/link`, `github/repo-link`, `github/health`, `usage`, and `galleries` requests now use the canonical `/v1/workspaces/:workspace/...` paths instead of the legacy `/v1/:workspace/...` wildcard (#613). The old paths keep working server-side, so this is a client-only move.

Files operations (`get`/`set`/`list`/`facets`/etc.) stay on the legacy wildcard for now — the canonical files vertical doesn't yet cover uploads, `/sign`, or `:key` metadata, and its list/search response shape differs from the bearer one.

Note: the canonical `github/comment` route requires the `files:write` scope, where the legacy path also accepted `files:read`. Default-minted CLI tokens carry read+write, so this is transparent for normal use; a manually-minted read-only token will now get a 403 from `uploads comment`.
