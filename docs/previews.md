# Workers Previews

A Preview is a branch environment for one worker: run `npx wrangler preview`
from an app directory and the branch gets its own URL, vars, secrets, and
bindings, without touching the production deployment. Previews are enabled on
the Build Internet account (Cloudflare docs:
[Workers Previews](https://developers.cloudflare.com/workers/previews/)).

Preview URLs are gated by Cloudflare Access. Sign in with a Cloudflare account
that is a member of the Build Internet account and you pass straight through.

`uploads-web` previews resolve at two URLs: the workers.dev one, and — since
#684 — a custom domain, `<preview-name>.preview.uploads.sh`. The custom
domain is safe post-#731: the production session cookie is host-only on
`uploads.sh`, so no `*.preview.uploads.sh` hostname ever receives it, and
previews stay signed out either way (see the GitHub-login/dev-session note
below). The wildcard DNS record and certificate for `*.preview.uploads.sh`
are auto-provisioned by Cloudflare on the first preview deploy after this
merges — certificate issuance can lag the DNS record by a few minutes, so a
brand-new preview name may fail TLS briefly before it's usable.

Access must stay in front of both preview URL forms. Cloudflare's docs say
the auto-created per-worker Access application covers workers.dev preview
URLs and custom-domain preview URLs alike, but treat that as unverified until
checked: after the first deploy under `*.preview.uploads.sh`, confirm in Zero
Trust → Access → Applications that the wildcard is actually gated. If it
isn't, add an Access app for `*.preview.uploads.sh` matching the existing
preview setup (Cloudflare IdP, restricted to Build Internet account members,
instant auth).

## No automatic branch preview

Pushing a branch does not create a preview deploy for `uploads-web`,
`uploads-auth`, or `uploads-api`. Non-production branch builds are off for
those workers. Production builds on `main` are unchanged. `uploads-mcp`,
`uploads-viewer`, and `uploads-slack` are unchanged. `uploads-read-gate` is
not in Workers Builds until the hosted read-gate cutover.

Do not upload a preview by default. Upload one only when the change needs a
live worker to verify. Local `pnpm dev:web` is the usual check for UI.

The old Workers Builds "Branch Preview URL" was an aliased Version URL
(`preview_urls: true`). That URL serves the uploaded version with production
bindings. The rest of this document describes `npx wrangler preview`, which
uses a separate preview tier. To mint a Version URL by hand, run the
following from the app directory. `--env-file-if-exists` loads
`CLOUDFLARE_API_TOKEN` from the repo-root `.env`, the same way each app's
deploy script does.

```bash
# apps/web — the worker serves ./dist
pnpm build
node --env-file-if-exists=../../.env node_modules/wrangler/bin/wrangler.js versions upload --preview-alias <alias>

# apps/api
node --env-file-if-exists=../../.env node_modules/wrangler/bin/wrangler.js versions upload --preview-alias <alias>
```

The alias is a DNS label. Use lowercase letters, digits, and dashes, and
start with a letter. `<alias>-<worker-name>` must be at most 63 characters.
A branch name that contains `/` is not a valid alias. Replace each `/` with
`-`. Wrangler prints `Version Preview Alias URL` when the upload succeeds.
The hostname is `https://<alias>-<worker-name>.<subdomain>.workers.dev`. The
upload does not move production traffic.

`uploads-auth` used to export a Durable Object, which blocks Version URLs. It
no longer does, so a version upload should work there too, but that is not
yet verified. `npx wrangler preview` from `apps/auth` still works and is the
preview tier below. A push does not run it.

Only `npx wrangler preview` uses the preview tier described below.

## The two layers

**Layer 1 — the shared preview tier.** The `previews` block in each app's
`wrangler.jsonc` is the default every preview of that worker gets. All
previews of `uploads-api`, on every branch, share the same preview-tier
resources: the `uploads-preview` D1, the preview REGISTRY KV, the
`uploads-preview-default` bucket. Previews are isolated from production, not
from each other.

**Layer 2 — per-branch overrides.** `wrangler preview` reads the `previews`
block from the current branch. A branch that needs to deviate edits its own
`previews` block — for example, pointing `DB` at a scratch database — and the
change applies only to that branch's preview. Vars and secrets can also be
overridden per-preview: `wrangler preview secret put NAME --name <preview>`,
or the Preview's settings in the dashboard.

Bindings do not inherit from the production config: a preview gets only what
the `previews` block lists. When you add a binding to an app, add it to the
`previews` block too, or `wrangler preview` warns that the configuration has
diverged.

## Which app to preview

Cross-service references (service bindings, origin vars) point at production
by default, so one preview usually suffices:

| Change                | Preview                | Everything else                                                                                                                                                                                                  |
| --------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web UI                | `uploads-web` only     | Talks to prod api/auth — realistic, signed out                                                                                                                                                                   |
| API                   | `uploads-api` only     | Hit its URL with curl or the CLI; writes land in the preview tier; sessions verify against prod auth                                                                                                             |
| Cross-app (web + api) | Both                   | Override the web preview's `UPLOADS_API_ORIGIN` var to the api preview's URL                                                                                                                                     |
| Auth                  | `uploads-auth`, rarely | Needs a per-preview `BETTER_AUTH_URL` override to the WEB preview's origin (#731: same-origin mode — see apps/auth/wrangler.jsonc); magic-link flows only — GitHub OAuth callbacks only cover production origins |

Platform rules that shape this: service bindings always call the bound
worker's production deployment, and cron triggers, queue consumers, and
routes never run against a preview.

## Playbook

**Deploying a preview.**

```bash
cd apps/web && pnpm build   # web only; the other apps bundle on deploy
npx wrangler preview        # preview name defaults to the git branch
```

The output prints two URLs: the Preview URL (tracks the latest deployment for
that name) and an immutable per-deployment URL. Clean up with
`wrangler preview delete --name <name> -y` (the name is a flag, not a
positional — bare `delete <name>` prints help) — the account caps active
previews per worker, evicting the least-recently deployed first.

**Schema-changing branches.** The shared `uploads-preview` D1 serves every
open preview, so applying a branch's migration migrates it for all of them.
Additive migrations: fine — apply through the companion config:

```bash
npx wrangler d1 migrations apply uploads-preview --remote -c apps/api/wrangler.preview.jsonc
```

(The companion `wrangler.preview.jsonc` exists because `d1 migrations` cannot
see databases declared inside a `previews` block.) Destructive or risky
migrations: give the branch a scratch database instead — in the branch's own
`previews` block, remove the shared entry's identifier. For KV, D1, and R2,
omitting the identifier (`id`, `database_name`, or `bucket_name`) makes
`wrangler preview` create a fresh resource on first run and write the
identifier back to the config. Revert the override before merge and delete
the scratch resource.

**Seeding.** The preview tier starts empty — no workspaces, no files. Mint a
workspace against the preview api URL the same way you would against
production (see [docs/workspaces.md](workspaces.md)), or exercise public
endpoints directly.

**Secrets.** Preview secrets start unset, and every secret-gated path fails
closed — an unset `ADMIN_TOKEN` means 401, an unset GitHub App key degrades
the comment path. Leave them unset until a branch actually needs one, then
set it per-preview (`wrangler preview secret put NAME --name <preview>`) so
the blast radius stays one branch. Avoid seeding production credentials into
the preview base config.

## Decisions of record

- `uploads-web` previews resolve at `*.preview.uploads.sh` (custom domain,
  `previews_enabled` in `apps/web/wrangler.jsonc`) as well as workers.dev
  (#684). This was on hold until #731 made the session cookie host-only on
  `uploads.sh` — before that, a `uploads.sh` subdomain would have received
  the production session cookie. Only the web worker has this; `uploads-api`
  and `uploads-auth` stay workers.dev-only previews.
- Previews stay signed out regardless of URL form: GitHub OAuth's callback is
  pinned to the production origin (won't complete against a preview URL),
  and the dev-session escape hatch doesn't exist outside local dev. This is
  by design, not a gap to fix — see the "Which app to preview" table above
  for what "realistic, signed out" means for UI review.
- `preview_urls: true` stays on `uploads-web`, `uploads-auth`, and
  `uploads-api` so a manual `wrangler versions upload` can mint a Version URL.
