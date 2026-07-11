# @uploads/mcp

Remote MCP server for uploads.sh — a standalone Hono worker on
`agents.uploads.sh` (with `mcp.uploads.sh` as an alternate), sibling to `apps/api`. It shares the API's bindings
(registry KV, D1, R2 buckets) and its per-workspace bearer auth, and reuses
the CLI package's transport-agnostic MCP core (`@buildinternet/uploads/mcp`).

Stateless MCP Streamable HTTP: one JSON-RPC message per POST, no sessions or
SSE (GET/DELETE on the endpoint are 405). Tools: `put` (base64 upload →
public URL + GitHub-ready markdown), `list`, `delete`, `health`. Filesystem/
`gh`-dependent tools (attach, comment, doctor) live only in the stdio server
(`uploads mcp`).

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
