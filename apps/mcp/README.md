# @uploads/mcp

Remote MCP server for uploads.sh — a standalone Hono worker on
`mcp.uploads.sh`, sibling to `apps/api`. It shares the API's bindings
(registry KV, D1, R2 buckets) and its per-workspace bearer auth, and reuses
the CLI package's transport-agnostic MCP core (`@buildinternet/uploads/mcp`).

Stateless MCP Streamable HTTP: one JSON-RPC message per POST, no sessions or
SSE (GET/DELETE on the endpoint are 405). Tools: `put` (base64 upload →
public URL + GitHub-ready markdown), `list`, `delete`, `health`. Filesystem/
`gh`-dependent tools (attach, comment, doctor) live only in the stdio server
(`uploads mcp`).

The REST API's upload guardrails apply: the stored content type is sniffed
server-side from the bytes (no caller override) and checked against the
workspace's allowlist, uploads are size-capped, and writes (`put`/`delete`)
are rate limited per workspace.

## Endpoint

```
POST https://mcp.uploads.sh/<workspace>/mcp
Authorization: Bearer up_<workspace>_…
```

Claude Code:

```bash
claude mcp add --transport http uploads https://mcp.uploads.sh/<ws>/mcp \
  --header "Authorization: Bearer <token>"
```

## Deploy

```bash
pnpm deploy:mcp   # from the repo root
```

The custom domain and the first deploy need one-time Cloudflare setup —
Workers Builds currently only auto-deploys `uploads-api` and `uploads-web`.
The bindings in `wrangler.jsonc` are shared with `uploads-api`; keep the ids
in sync.
