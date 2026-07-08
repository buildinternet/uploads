# uploads

Lightweight file-hosting backend on Cloudflare Workers, built on
[files-sdk](https://files-sdk.dev) so the storage layer is provider-agnostic
(R2 today; any files-sdk adapter later). Successor to the R2 upload scripts in
`buildinternet-skills/github-screenshots`.

> **Active development — not production-ready.** uploads.sh is being built in
> the open and its APIs (including auth) will change without notice. Don't rely
> on it for anything you can't afford to lose or re-key.

## Quick start

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars
pnpm workspace:add default --local
pnpm dev            # API on :8787; pnpm dev:web for the site
```

Upload a file:

```bash
curl -X PUT http://localhost:8787/v1/default/files/test.txt \
  -H "Authorization: Bearer $UPLOADS_TOKEN" \
  -H "Content-Type: text/plain" \
  --data-binary "hello"
```

## Layout

```
apps/api            Hono worker — REST API, deploys to api.uploads.sh
apps/web            Astro placeholder — future browse/manage UI
packages/storage    @uploads/storage — files-sdk adapter factory
packages/uploads    @buildinternet/uploads — CLI + client for GitHub image embeds
skills/uploads-cli  Agent skill for driving the CLI
```

The API and web app are separate deployables. All storage access goes through
`createStorage()` in `packages/storage` — adding a provider is one new case
plus peer deps, no API changes.

## Docs

| Doc | Contents |
| --- | -------- |
| [workspaces](docs/workspaces.md) | Multi-tenant model, registration, BYO-bucket |
| [admin-tokens](docs/admin-tokens.md) | Minting, listing, and revoking upload tokens |
| [api](docs/api.md) | REST routes and CLI usage |
| [deploy](docs/deploy.md) | Cloudflare setup and production deploy |
| [roadmap](docs/roadmap.md) | Planned features |

Agent and contributor conventions live in [AGENTS.md](AGENTS.md).