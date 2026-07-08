# @uploads/api

Hono worker — workspace-scoped REST API for file I/O. Deploys to **api.uploads.sh**.

## Routes

| Path                     | Auth             | Purpose                           |
| ------------------------ | ---------------- | --------------------------------- |
| `GET /health`            | —                | Liveness                          |
| `/admin/*`               | admin token      | Mint/list/revoke workspace tokens |
| `/v1/:workspace/files/*` | workspace bearer | Put, get, head, list, delete      |

Workspaces are tenant records in the `REGISTRY` KV namespace. Auth and storage wiring live in `src/workspace.ts` and `src/storage.ts`; all object I/O goes through `@uploads/storage`.

## Layout

```
src/
  index.ts          Hono app + route mounting
  workspace.ts      KV lookup, bearer auth, WorkspaceRecord
  storage.ts        createStorage() bridge from workspace → @uploads/storage
  routes/files.ts   File CRUD handlers
  routes/admin.ts   Token minting
scripts/
  add-workspace.mjs Register a workspace (prod or --local KV)
```

## Commands

```bash
pnpm dev                              # wrangler dev (:8787)
pnpm run deploy                       # production deploy
pnpm types                            # regenerate worker-configuration.d.ts
pnpm workspace:add <name> --local     # dev KV registration
```

After editing `wrangler.jsonc`, run `pnpm types` — `Env` is generated, never hand-written.

## Docs

- [API reference](../../docs/api.md)
- [Workspaces](../../docs/workspaces.md)
- [Admin tokens](../../docs/admin-tokens.md)
- [Deploy](../../docs/deploy.md)
