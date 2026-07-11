# @uploads/api

Hono worker — workspace-scoped REST API for file I/O. Deploys to **api.uploads.sh**.

## Routes

| Path                     | Auth             | Purpose                                       |
| ------------------------ | ---------------- | --------------------------------------------- |
| `GET /health`            | —                | Liveness                                      |
| `/admin/*`               | admin token      | Mint/list/revoke tokens; credential reencrypt |
| `/v1/:workspace/files/*` | workspace bearer | Put, sign, get, list, delete                  |
| `/v1/:workspace/usage/*` | workspace bearer | Usage, reconcile, purge-expired               |

Workspaces are tenant records in the `REGISTRY` KV namespace. Auth and storage wiring live in `src/workspace.ts` and `src/storage.ts`; all object I/O goes through `@uploads/storage`. Put/sign share `files-core` (guards, budgets, key policy).

## Layout

```
src/
  index.ts          Hono app + scheduled retention
  workspace.ts      KV lookup, bearer auth, WorkspaceRecord
  files-core.ts     Shared put/list/delete + key governance
  key-policy.ts     allowedKeyPrefixes / maxKeyDepth
  storage.ts        createStorage() bridge → @uploads/storage
  routes/           files, usage, auth, admin
scripts/
  add-workspace.mjs           Register a workspace (prod or --local KV)
  set-workspace-limits.mjs    Budgets, retention, key policy
```

## Commands

```bash
pnpm dev                              # wrangler dev (:8787)
pnpm run deploy                       # D1 migrate + production deploy
pnpm types                            # regenerate worker-configuration.d.ts
pnpm workspace:add <name> --local     # dev KV registration
pnpm workspace:limits <name> --allowed-prefixes default --max-key-depth 8
```

After editing `wrangler.jsonc`, run `pnpm types` — `Env` is generated, never hand-written.

## Docs

- [API reference](../../docs/api.md)
- [Workspaces](../../docs/workspaces.md) (budgets + key destinations)
- [Operator runbook](../../docs/ops.md)
- [Admin tokens](../../docs/admin-tokens.md)
- [Deploy](../../docs/deploy.md)
