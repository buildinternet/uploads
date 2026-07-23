# Contributing

Thanks for looking at **uploads**. This repo is the monorepo behind
[uploads.sh](https://uploads.sh) — the API worker, the auth worker, the MCP
server, the Astro web app, the shared packages, and the `@buildinternet/uploads`
CLI that ships to npm.

The conventions below keep changes easy to review and keep the published CLI
behaving consistently for the people and agents that install it. Day-to-day
working conventions for agents live in [AGENTS.md](AGENTS.md); this document
covers the contribution loop around them.

## Code of conduct

Be respectful and assume good intent. Maintainers may edit, lock, or remove
contributions that are abusive or off-topic.

## Before you start

- **Open an issue first for anything significant** — a new command, a wire
  format change, a new storage provider, or anything that changes how the CLI
  behaves for existing users. A short discussion saves a rewrite.
- Small fixes (typos, docs, an obvious bug with a test) can go straight to a PR.
- External contributors work through a fork and a pull request.

## What you can run without any accounts

The core loop never requires access to the production infrastructure:

- **No external accounts.** `pnpm install`, `pnpm check`, `pnpm typecheck`, and
  `pnpm test` all run secret-free — that is how CI runs them. `pnpm dev` boots
  the API worker with `wrangler dev`, which simulates R2, KV, and D1 on disk.
- **Cloudflare account (optional).** You need one only to deploy, or to register
  a workspace against a real bucket in HTTP mode.
- **Hosted-only.** The production bindings in each `wrangler.jsonc`, the GitHub
  App, Stripe billing, and the deployed contract tests are not reproducible from
  a fork by design.

## Setup

**Prerequisites:** Node ≥24 and pnpm ≥11 (`corepack enable`; versions pinned in
`package.json` and `.nvmrc`).

```bash
pnpm bootstrap   # tooling, deps, env files from their *.example, wrangler types,
                 # local D1 migrations, and the local `default` workspace
pnpm doctor      # read-only diagnosis: what is present, what is missing, the fix
```

`bootstrap` is idempotent. It never overwrites an existing env file and never
re-mints an existing local workspace. `doctor` only reads.

Manual setup, the full dev-stack detail, and a curl smoke test live in
[docs/local-dev.md](docs/local-dev.md).

## Local development

```bash
pnpm dev                     # API worker on :8787 (local R2 + KV + D1)
pnpm dev:web                 # Astro site
pnpm dev:stack               # authenticated Auth + API + Web stack (portless)
pnpm dev:stack:check --json  # machine-readable readiness + session smoke proof
```

`pnpm dev:stack` runs through [portless](https://npmjs.com/portless), so the
stack gets named `.localhost` origins instead of bare ports and local sign-in
behaves like production — `/account/*` and `/admin/*` work in a local browser.
[docs/local-dev.md](docs/local-dev.md#named-local-urls-portless) has the origin
table, the real-TLD mode for OAuth, and a curl smoke test.

Local `wrangler … --local` calls boot miniflare, and an orphaned one can balloon
to multiple gigabytes of RAM. Prefer the repo scripts (`pnpm doctor`,
`pnpm workspace:add`, `pnpm migrate:d1:local`) — they wrap wrangler in a
time-bounded runner. See
[AGENTS.md](AGENTS.md#local-wrangler--agent-hygiene) and
[docs/ops.md](docs/ops.md#local-wrangler-gotchas).

## Checks

```bash
pnpm check        # oxlint + oxfmt --check — the same gate CI runs
pnpm lint:fix     # autofix lint
pnpm format       # autofix formatting
pnpm typecheck    # wrangler types + tsc across every workspace
```

The repo formats with **oxfmt**, not Prettier. A Husky pre-commit hook runs
`pnpm types` then `lint-staged` on staged files; `pnpm install` installs it.

Run `pnpm types` after any `wrangler.jsonc` change. `Env` is generated into a
gitignored `worker-configuration.d.ts` and is never hand-written, and
type-aware lint rules need those files to exist.

## Testing

```bash
pnpm test         # the whole suite in one Vitest process — CI's Test job
pnpm test:api     # one package (also test:mcp / test:auth / test:web / test:cli)
```

`pnpm test` loads `vitest.projects.ts`, which registers every workspace package
as a Vitest project. The filename is deliberate: a root `vitest.config.ts` would
hijack the per-package `pnpm --filter … test` runs, which use Vitest defaults.

Tests are plain Vitest with in-process fakes. There is no `@cloudflare/vitest-pool-workers`
setup, so a test that needs a binding fakes it rather than booting a worker.

CI runs three gates on every pull request: **Lint & Format** (including a
changeset lint), **Test**, and package/bundle verification for the npm package
and the remote MCP worker.

## Screenshots: stage as you go

If your change is visually observable — web UI, an email template, rendered
output — capture screenshots at each milestone while you work. Do not wait for
the PR to exist.

```bash
uploads put ./after.png --meta path=/settings --state after
uploads screenshot http://localhost:4321/settings --out after.png --state after
```

On a non-default branch both commands stage the file automatically. When the PR
opens, everything staged is promoted into one managed "📎 Attachments" comment.
The [`github-screenshots`](skills/github-screenshots) skill has the full
workflow.

Product-facing examples use the installed binary (`uploads …`). Reserve
`pnpm uploads …` for in-repo work, where the root script builds the package
first.

## Pull requests

Write PR descriptions for humans first. Prefer plain language over a dense
bullet dump of identifiers.

**Shape:**

1. **In plain terms** — one short paragraph: what changes and why it matters.
2. **What it does / what it is not** — a few concrete bullets. Call out opt-in
   versus breaking, and anything deliberately deferred.
3. **How to try it** — only when useful, using the installed CLI.
4. **Technical notes** — optional, for implementers. Keep it secondary.
5. **Test plan** — checkboxes for what you ran and what remains.

**Titles** use a conventional-commit type prefix and a plain-language subject:

```text
feat: organize upload paths (typed destinations + optional folder rules)
fix(web): don't offer Stripe portal for comped workspaces
docs: document before/after pairing
```

- Common types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`.
- Start the subject with a lowercase letter and lead with the outcome.
- Avoid sensational language ("comprehensive", "world-class").
- Do **not** request a CodeRabbit review on every PR. Org policy is on-demand
  only — comment `@coderabbitai review` or add the `coderabbit:review` label
  when a review genuinely helps.

Keep a PR focused, keep CI green, and add tests for behavior you change.

## Releasing the CLI

Any user-visible change to `@buildinternet/uploads` — CLI, client, or the
bundled MCP server — needs a changeset:

```bash
pnpm changeset
```

Two rules matter. Only `"@buildinternet/uploads"` belongs in the changeset
header — a changeset naming a private `@uploads/*` package produces an empty
version PR that blocks the next npm publish, which `pnpm changeset:lint` rejects
as a CI gate. And never hand-edit the package `version`.

Merging to `main` opens a "version packages" PR; merging that PR publishes to
npm. Do not merge one unless shipping is intentional. The full process is in
[docs/releasing.md](docs/releasing.md).

## Deployment

Production worker deploys normally happen through Cloudflare Workers Builds on
push to `main`. `.github/workflows/d1-migrations.yml` applies remote D1
migrations when `apps/api/migrations/**` changes. Manual deploys
(`pnpm run deploy`, or `deploy:api` / `deploy:web` / `deploy:mcp` /
`deploy:auth`) need `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in
`.env`. Use `pnpm run deploy`, not bare `pnpm deploy` — that is pnpm's built-in.

Full setup is in [docs/deploy.md](docs/deploy.md); the operator runbook is
[docs/ops.md](docs/ops.md).

## Things to keep in mind

- **All storage access goes through `createStorage()`** in `packages/storage`.
  Never import a files-sdk adapter or touch an R2 binding from route code.
  Adding a provider is one new case plus its peer deps.
- **No workspace is special in code**, including `default`. A workspace is a
  tenant record in the `REGISTRY` KV namespace. Mutate those records through
  the versioned `mutateWorkspaceRecord` helper, never a bare `REGISTRY.put`.
- **HTTP errors throw `AppError` subclasses** from `@uploads/errors`. Let
  `respondError` serialize the envelope; never hand-roll `c.json({ error })`.
- **Secrets never go in `wrangler.jsonc` or source.** Workspace secrets live in
  KV records. Global secrets go through `wrangler secret put` or a gitignored
  `.dev.vars`. Never edit somebody's `.env` — change the `*.example` template.
- **Upload guardrails live in `apps/api/src/guards.ts`** — the byte cap and the
  content-type allowlist verified by magic-byte sniffing. The stored content
  type comes from the bytes, never the client header.
- **Auth is per-workspace bearer tokens**, hashed and compared in constant time,
  with uniform 401s so workspace names cannot be enumerated.
- **Keep the two skills in sync** with the CLI. `skills/github-screenshots` is
  the workflow skill and `skills/uploads-cli` is the full reference; both ship
  to users, so a new flag belongs in the reference.
- **Docs follow a house style** — active voice, one idea per sentence, one term
  per concept. See [AGENTS.md](AGENTS.md#writing-docs).

## Reporting bugs and security issues

Open an issue for bugs, and include the CLI version (`uploads --version`), the
command you ran, and the output.

For a security problem, do not open a public issue. Report it privately through
[GitHub security advisories](https://github.com/buildinternet/uploads/security/advisories/new).

## License

This project is licensed under [Apache 2.0](LICENSE). Contributions you submit
are licensed under the same terms. There is no separate CLA. If you contribute
work owned by an employer, make sure you have their sign-off first.
