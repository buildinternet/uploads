# uploads

Lightweight file-hosting backend on Cloudflare Workers, built on
[files-sdk](https://files-sdk.dev) so the storage layer is provider-agnostic
(R2 today; any files-sdk adapter later). Successor to the R2 upload scripts in
`buildinternet-skills/github-screenshots`.

> **Active development — not production-ready.** uploads.sh is being built in
> the open and its APIs (including auth) will change without notice. Don't rely
> on it for anything you can't afford to lose or re-key.

## Agent quick start

Install the CLI, enroll once, then attach media from a checked-out PR branch:

```bash
npm install --global @buildinternet/uploads
uploads login
uploads attach ./before.png ./after.png
```

For a one-off or pinned run without a global install:

```bash
npx @buildinternet/uploads@0.1.0 login
npx @buildinternet/uploads@0.1.0 attach ./before.png ./after.png
```

`attach` detects the GitHub repository and current PR through `gh`, uploads all
files, and creates or updates one managed attachments comment. Use
`--pr <number>` or `--issue <number>` when inference is not possible, and
`--no-comment` when only the public URLs and Markdown are wanted.

An uploads.sh administrator creates a short-lived, single-use enrollment code;
`uploads login` exchanges it and saves the resulting workspace token. Routine
agents never receive or need `ADMIN_TOKEN`. See [enrollment](docs/enrollment.md).
Hosted files are public, including media attached to private repositories. Do
not upload secrets or sensitive UI.

For agent runtimes, install the checked-in skill as well:

```bash
npx skills add buildinternet/uploads --skill uploads-cli
```

## Local development quick start

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

### CLI

The `@buildinternet/uploads` package wraps the API for scripting and GitHub
image embeds. `pnpm workspace:add` prints a bearer token once — save it to
`.env` (from `.env.example`) or run `pnpm uploads setup --token <token>`.

```bash
cp .env.example .env   # fill in UPLOADS_TOKEN from workspace:add output
pnpm uploads put ./shot.png --env-file .env
# stdout: public URL + ready-to-paste markdown; stderr: human summary
```

**How keys work:** default `put` lands under `screenshots/…`. Prefer
`--destination screenshots` (or `gh` with `--pr`/`--issue`) over inventing roots —
workspaces may allowlist only those destinations. Use `--pr`/`--issue` for stable,
hash-free GitHub keys; use `--key` only for an exact path under an allowed root.

More output control:

```bash
pnpm uploads put ./shot.png --format url --env-file .env
pnpm uploads put ./shot.png --repo myorg/myapp --ref 1722 --width 700 --env-file .env
```

### GitHub embeds

GitHub's native image hosting only works through a browser session — agents
and `gh` need a public URL first. The CLI uploads to R2 and returns stable
markdown you can drop into a PR or issue.

**Stable PR/issue attachments** (`--pr` / `--issue`) use hash-free keys so
re-uploading the same filename overwrites in place and the URL never changes:

```bash
pnpm uploads put ./after.png --pr 123 --alt "Dashboard after" --env-file .env
# key: gh/<owner>/<repo>/pull/123/after.png
```

**Managed attachments comment** (`--comment`, requires local `gh` auth)
creates or updates a single comment listing every file attached to that
PR/issue — the upload still succeeds if `gh` is unavailable:

```bash
pnpm uploads put ./after.png --pr 123 --comment --env-file .env
pnpm uploads comment --pr 123 --env-file .env   # re-sync without uploading
```

> **Privacy:** Hosted files are served from a public CDN with no link to GitHub
> repo visibility. A screenshot on a private PR is still reachable by anyone who
> knows or guesses the URL — `--pr`/`--issue` keys embed the repo path and
> filename (`gh/myorg/myapp/pull/123/after.png`), so generic names are easier
> to guess than hashed keys. Treat uploads as public; don't host secrets or
> sensitive UI. Tighter access controls for private repos are planned — see
> [roadmap](docs/roadmap.md).

See `skills/uploads-cli/SKILL.md` for agent-oriented usage and
[docs/api.md](docs/api.md) for REST routes.

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

| Doc                                          | Contents                                            |
| -------------------------------------------- | --------------------------------------------------- |
| [workspaces](docs/workspaces.md)             | Multi-tenant model, budgets, key policy, BYO-bucket |
| [ops](docs/ops.md)                           | Operator runbook (limits, retention, secrets)       |
| [enrollment](docs/enrollment.md)             | Agent login, scopes, expiry, and migration          |
| [admin-tokens](docs/admin-tokens.md)         | Minting, listing, and revoking upload tokens        |
| [api](docs/api.md)                           | REST routes and CLI usage                           |
| [deploy](docs/deploy.md)                     | Cloudflare setup and production deploy              |
| [contract testing](docs/contract-testing.md) | Deployed smoke checks and release gate              |
| [roadmap](docs/roadmap.md)                   | Planned features                                    |

Agent and contributor conventions live in [AGENTS.md](AGENTS.md).
