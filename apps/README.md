# apps

Deployable applications. API and web are separate Workers — see each app's README.

| Directory    | Package              | Deploy target                              |
| ------------ | -------------------- | ------------------------------------------ |
| `api/`       | `@uploads/api`       | api.uploads.sh                             |
| `web/`       | `@uploads/web`       | uploads.sh site                            |
| `slack/`     | `@uploads/slack`     | agents.uploads.sh/slack/\*                 |
| `read-gate/` | `@uploads/read-gate` | hosted reads (`store`, `storage`, `embed`) |

`read-gate/` serves hosted reads on `store`, `storage`, and `embed`. It 404s
a safety hold and forwards every other request. The runbook is
[docs/ops.md](../docs/ops.md#hosted-read-gate).

```bash
pnpm dev          # API on :8787 (from repo root)
pnpm dev:web      # Astro dev server
pnpm run deploy   # both workers
```

Shared libraries live in [`packages/`](../packages/). REST reference: [`docs/api.md`](../docs/api.md).
