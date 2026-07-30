# @uploads/mcp

Remote MCP server for uploads.sh — a standalone Hono worker on
`agents.uploads.sh` (with `mcp.uploads.sh` as an alternate), sibling to `apps/api`. It shares the API's bindings
(registry KV, D1, R2 buckets) and its per-workspace bearer auth, and reuses
the CLI package's transport-agnostic MCP core (`@buildinternet/uploads/mcp`).

Stateless MCP Streamable HTTP: one JSON-RPC message per POST, no sessions or
SSE (GET/DELETE on the endpoint are 405). Tools cover put/list/delete, metadata
(`get_metadata` / `set_metadata` / `find_files`), galleries, usage, health,
branch staging (`put` with `branch` + `repo`), promote (`promote` with
`repo`/`pr`/`branch`), and managed-comment sync via `put`/`comment`/`promote`
(bot-only; body honors the repo's `.uploads.yml` when present — see
https://uploads.sh/docs/comment-config). Local `attach`/`doctor` (filesystem or
`gh`) and the git-defaulting `staged` tool live only on the stdio server
(`uploads mcp`).

### Protocol eras

The worker speaks both MCP spec revisions on the same `/mcp` endpoint and
picks the era per request:

- **`2026-07-28` (modern).** No `initialize` handshake. Each request carries
  its protocol version and client capabilities in a per-request `_meta`
  envelope (`io.modelcontextprotocol/protocolVersion`,
  `io.modelcontextprotocol/clientCapabilities`), and the `Mcp-Method` and
  `Mcp-Name` headers are required — a request missing either gets a 400. A
  client can call `server/discover` to read back supported versions and
  capabilities before sending anything else. `tools/list` responses carry
  cache hints (`ttlMs: 3600000`, `cacheScope: "private"`): the tool catalog is
  static per deploy, so a generous TTL is honest, but it's auth-gated and
  scope-filtered per token, so a shared cache must not serve one caller's list
  to another.
- **`2025-era` (legacy).** The classic `initialize` → `tools/*` flow. Legacy
  requests still get plain JSON replies, not an SSE stream — the worker was
  already stateless and JSON-only before this migration, and the reply body
  does not change.

Either era, `GET`/`DELETE` on `/mcp` stay 405, and the worker does not
implement `subscriptions/listen` — it has no change notifications to push.

### Required request headers

Every POST must send both:

```
Content-Type: application/json
Accept: application/json, text/event-stream
```

A request without the content type gets 415, and one that does not accept both
media types gets 406 — even though replies are always plain JSON. Both headers
have been required by Streamable HTTP since revision `2025-03-26`, so
conformant clients already send them, but the worker did not enforce them
before it moved to the MCP SDK. A hand-rolled caller that omitted either used
to work and now does not.

### Legacy `initialize` params are validated

On the legacy leg, `initialize` params are checked against the spec schema, so
`capabilities` and `clientInfo` are both required:

```json
{
  "protocolVersion": "2025-06-18",
  "capabilities": {},
  "clientInfo": { "name": "x", "version": "1" }
}
```

Omitting either returns `-32603` with a validation dump. The spec has always
required them, but the pre-SDK server read only `protocolVersion` and ignored
the rest, so a partial handshake used to succeed.

The REST API's upload guardrails apply: content type is sniffed server-side,
size-capped, budget-checked, and subject to optional key policy
(`allowedKeyPrefixes` / `maxKeyDepth`). Writes are rate limited per workspace.

## Endpoint

```
POST https://agents.uploads.sh/mcp
Authorization: Bearer up_<workspace>_…
```

The workspace is inferred from the bearer token, so clients only need the URL
and the token. `https://agents.uploads.sh/<workspace>/mcp` remains as a
workspace-prefixed alternate, and `mcp.uploads.sh` as an alternate hostname.

Claude Code (or run `uploads install` to do this for you):

```bash
claude mcp add --transport http uploads https://agents.uploads.sh/mcp \
  --header "Authorization: Bearer <token>"
```

## Deploy

```bash
pnpm deploy:mcp   # from the repo root
```

Workers Builds also auto-deploys this worker on pushes to `main`. The bindings in `wrangler.jsonc` are shared with `uploads-api`; keep the ids
in sync.
