# apps

Deployable applications. API and web are separate Workers — see each app's README.

| Directory | Package        | Deploy target   |
| --------- | -------------- | --------------- |
| `api/`    | `@uploads/api` | api.uploads.sh  |
| `web/`    | `@uploads/web` | uploads.sh site |

```bash
pnpm dev          # API on :8787 (from repo root)
pnpm dev:web      # Astro dev server
pnpm run deploy   # both workers
```

Shared libraries live in [`packages/`](../packages/). REST reference: [`docs/api.md`](../docs/api.md).
