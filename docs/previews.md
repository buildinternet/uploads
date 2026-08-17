# Workers Previews

A Preview is a branch environment for one worker: run `npx wrangler preview`
from an app directory and the branch gets its own URL, vars, secrets, and
bindings, without touching the production deployment. Previews are enabled on
the Build Internet account (Cloudflare docs:
[Workers Previews](https://developers.cloudflare.com/workers/previews/)).

Preview URLs are gated by Cloudflare Access. Sign in with a Cloudflare account
that is a member of the Build Internet account and you pass straight through.

Do not confuse a Preview with the Workers Builds bot's "Branch Preview URL"
comment on PRs. That URL is the legacy aliased-version mechanism
(`preview_urls: true`) and runs against **production bindings**. Only
`npx wrangler preview` uses the preview tier described here.

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

| Change                | Preview                | Everything else                                                                                                              |
| --------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Web UI                | `uploads-web` only     | Talks to prod api/auth — realistic, signed out                                                                               |
| API                   | `uploads-api` only     | Hit its URL with curl or the CLI; writes land in the preview tier; sessions verify against prod auth                         |
| Cross-app (web + api) | Both                   | Override the web preview's `UPLOADS_API_ORIGIN` var to the api preview's URL                                                 |
| Auth                  | `uploads-auth`, rarely | Needs a per-preview `BETTER_AUTH_URL` override; magic-link flows only — GitHub OAuth callbacks only cover production origins |

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
`wrangler preview delete <name>` — the account caps active previews per
worker, evicting the least-recently deployed first.

**Schema-changing branches.** The shared `uploads-preview` D1 serves every
open preview, so applying a branch's migration migrates it for all of them.
Additive migrations: fine — apply through the companion config:

```bash
npx wrangler d1 migrations apply uploads-preview --remote -c apps/api/wrangler.preview.jsonc
```

(The companion `wrangler.preview.jsonc` exists because `d1 migrations` cannot
see databases declared inside a `previews` block.) Destructive or risky
migrations: create a scratch database and point the branch's own `previews`
block at it — that is the per-branch override doing its job. Revert the
override before merge.

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

- Previews stay on workers.dev URLs. Hostnames under `uploads.sh` would
  receive the `.uploads.sh`-scoped production session cookie, handing live
  sessions to unreviewed branch code. Revisit tracked in
  [issue #684](https://github.com/buildinternet/uploads/issues/684).
- The legacy `preview_urls: true` flags stay during the transition.
