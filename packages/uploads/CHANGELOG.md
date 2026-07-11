# @buildinternet/uploads

## 0.5.0

### Minor Changes

- 97a2e3c: `uploads admin invite create --email <address>` now delivers the invite magic link
  by email instead of printing it. The API sends from `invites@uploads.sh` via
  Cloudflare Email Sending; delivery is rate-limited per recipient and audit-logged
  without the code or link. On success the CLI confirms delivery and does not print the
  secret; if delivery fails the invite is still created and the CLI prints the link as a
  fallback.
- 97a2e3c: `uploads admin invite create` now prints a single self-contained magic link by
  default. The one-time code rides in the link's URL fragment (`…/invite?id=…#code=…`),
  which browsers never send to a server, so the invite page can offer a one-click login
  command while the code stays out of query strings, server logs, and referrers—and
  opening the page neither logs nor consumes it. Pass `--separate-code` for the previous
  two-channel output (a non-secret page URL plus a code you deliver separately). The
  invite page also now shows which workspace the invitation is for.
- 2245f63: Add `uploads admin invite create` as the user-facing invitation command and return a separate, non-secret onboarding page URL alongside the one-time login code. Alternate deployments can derive the page origin from `--api-url` or set it explicitly with `--web-url`; the previous `admin enrollment create` spelling remains supported.
- 29c7e83: Parse the nested API error envelope (`error.code` / `error.message`) while still accepting the legacy flat `{ error: string }` shape.

### Patch Changes

- ff5495a: Warn in CLI and agent tool help that uploads and predictable PR/issue attachment keys remain public for private and internal repositories.

## 0.4.0

### Minor Changes

- 383c7e9: Send allowlisted object provenance on put (`X-Uploads-Meta-*`: client, version, optimize/frame flags, source name). Put/head return `metadata`, including server-computed `content-sha256` of the stored body.

### Patch Changes

- cea6cd6: Mark the package `sideEffects: false` so Workers that import helpers from the main entry (e.g. the remote MCP worker) can tree-shake Node-only image code (`sharp` / optimize / frame) and deploy cleanly.

## 0.3.0

### Minor Changes

- 4c52c52: Add optional `--frame` (phone/browser/iphone-16-pro) on put/attach before optimize, and link uploads.sh in the managed GitHub attachments comment footer.
- 75844bb: Optimize still images to WebP on `put`/`attach` (and MCP) by default for leaner GitHub embeds (EXIF stripped unless `--keep-exif`), with `--no-optimize` / `UPLOADS_NO_OPTIMIZE` escape hatch.
- 3d17c0a: Add typed destinations (`--destination screenshots|gh|f` / MCP `destination`) and map API key-policy denials (`key_prefix_not_allowed`, `key_too_deep`) to a dedicated CLI error with an actionable hint.

### Patch Changes

- d83783f: Print actionable stderr hints on storage/upload budget and payload-too-large failures (point at `uploads usage` and size policy flags).

## 0.2.0

### Minor Changes

- 0a0db13: Add `uploads install` to register the agent skill and the hosted remote MCP server in one step. Prefer `agents.uploads.sh` (workspace inferred from the bearer token); `mcp.uploads.sh` remains an alternate hostname.
- 0a0db13: Add `uploads mcp` — a stdio MCP server whose tools mirror the CLI (`put`, `attach`, `list`, `delete`, `comment`, `health`, `doctor`, and later usage tools) under the same config resolution, with an optional per-call `workspace` override.
- 0a0db13: Add workspace usage maintenance surfaces for agents and the CLI: `uploads usage`, `uploads reconcile`, and `uploads purge-expired` (plus matching MCP tools and a usage line on `uploads doctor`). Surfaces storage counters, optional budget remaining, ledger rebuild from storage, and retention purge when configured on the workspace.
