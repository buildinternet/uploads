# Better Auth introduction — design + phased implementation plan

Date: 2026-07-12
Status: plan v2 (dedicated auth worker; decisions incorporated)
Supersedes-in-spirit: the "throwaway PoC" caveat in
`docs/superpowers/specs/2026-07-07-admin-token-minting-design.md`, which names
Better Auth as the intended replacement.

## Goal

Introduce Better Auth as the real identity layer for uploads.sh:

- **Users + organizations** as first-class concepts (today there are neither —
  only KV workspace records and bearer tokens).
- **GitHub OAuth + magic links** as the human sign-in methods.
- **Device-authorization grant** (RFC 8628) so `uploads login` works from the
  CLI without pasting enrollment codes.
- **Admin surface**: session-authenticated management of invites, workspaces,
  and users — replacing raw `ADMIN_TOKEN` curl calls for humans (the token
  stays for scripts/ops during the transition).

The plan is written so each phase is an independently executable brief for a
subagent, with the orchestrator (main session) reviewing between phases.

## Decisions log (2026-07-12 review)

- **Dedicated auth worker** at `auth.uploads.sh` (new `apps/auth`), not
  embedded in `apps/api`. New pattern for us; rationale in D1.
- **Latest stable better-auth** at install time (currently 1.6.23; 1.7 is in
  RC). The pins in releases/room-configurator are incidental — do not copy
  them. Where this plan cites their workarounds, verify against the installed
  version before applying.
- **1 org = 1 workspace** for now, with wire/data shapes designed so
  one-org-many-workspaces can happen later without breaking clients.
- **Tokens are credentials that receive workspace grants at mint time.**
  Exactly one grant today; the API contract accepts a list (D5). Personal
  API tokens are a foreseeable follow-on.
- **Magic links in scope for v1** alongside GitHub.
- **Device-flow static client id** for the CLI. Full `oauthProvider` plugin
  (third-party OAuth clients) is explicitly out of scope for now, but likely
  near-term — don't design against it.
- **Future webhooks service** may absorb parts of this (notably outbound
  email and event fan-out). Prefer seams it can slot into (D8).
- **First-admin bootstrap**: seed SQL is the primary path, with an
  `ADMIN_TOKEN`-gated promote endpoint as fallback (D9).
- **Secrets via Cloudflare Secrets Store**, bindings prefixed `UPL_`
  (mirrors room-configurator's `RS_` convention). The `_DEV` dev-var footgun
  fully applies (D7).
- **Email sender**: `noreply@uploads.sh` for all auth mail (magic links,
  invitations).

## Prior art consulted

Two sibling repos run Better Auth on a Hono Cloudflare Worker + D1 + Drizzle
adapter with the organization plugin:

- `~/Code/releases` (`workers/api/src/auth/index.ts`) — closest template; has
  **deviceAuthorization + bearer** backing its own CLI login, admin +
  organization plugins, magic link, GitHub social wired-but-inert,
  hand-written SQL migrations applied via `wrangler d1 migrations apply`.
- `~/Code/room-configurator` (`apps/api/src/betterauth/index.ts`) — same
  skeleton; org auto-provisioning hooks, prefixed nanoid IDs, Secrets Store
  bindings with dev fallbacks.

Both embed auth in the API worker; we deliberately deviate (D1). Their
documented footguns are called out inline as **⚠ footgun**.

## Architecture decisions

### D1. Dedicated auth worker: `apps/auth` on `auth.uploads.sh`

New Hono worker (`uploads-auth`) whose only job is Better Auth. The handler
mounts at the worker root with Better Auth's default `basePath: /api/auth`
(kept for maximal doc/example compatibility; revisit only if we want vanity
paths).

Why this simplifies things (vs the prior repos' embedded pattern):

- **CORS becomes trivial**: the auth worker serves exactly one credentialed
  CORS policy for `https://uploads.sh` (+ dev origins). No ordering dance
  against a global wildcard CORS in the API worker — a recurring source of
  bugs in both reference repos.
- **Dependency isolation**: better-auth + drizzle stay out of the upload hot
  path's bundle and cold-start.
- **Independent migrations/deploys**: auth schema changes never ride along
  with API deploys.
- **Ownership boundary**: `apps/api` keeps zero knowledge of auth tables.

Topology:

- **Own D1 database** `uploads-auth` (binding `DB` in `apps/auth`), with its
  own `apps/auth/migrations/` dir. Auth tables do NOT live in
  `uploads-production`.
- **Service binding** `AUTH` from `apps/api` → `apps/auth` for session
  verification. The API worker forwards `Cookie`/`Authorization` headers to
  `GET /api/auth/get-session` over the binding (no public hop, no CORS).
  The auth worker additionally exposes a small **internal-only API** (path
  prefix `/internal/*`, rejected unless the request arrived via service
  binding — check is straightforward since service-binding requests are the
  only way to reach a worker without a route match, but implement an explicit
  header/secret guard as defense in depth) for queries Better Auth doesn't
  expose directly, e.g. `GET /internal/memberships?userId=…`.
- **Cookies** on `.uploads.sh` (`advanced.crossSubDomainCookies`) so sessions
  set by `auth.uploads.sh` are visible to pages on `uploads.sh` and requests
  to `api.uploads.sh`.
- **trustedOrigins**: `https://uploads.sh` + dev/portless origins, via a
  tested helper (copy releases' `authTrustedOrigins` shape).
- Later, the **`jwt` plugin + JWKS** gives `apps/api`, `apps/mcp`, and the
  future webhooks service stateless verification without a binding call.
  Not required for v1; note it as the scaling path.

Dev story: `wrangler dev` multi-worker (service bindings work locally when
both dev sessions run; document the two-terminal or `wrangler dev -c`
multi-config flow) — wire scripted invocations through
`apps/api/scripts/run-timed.mjs` like the existing D1 flows.

### D2. Database: Drizzle adapter over D1, hand-written SQL migrations

- `apps/auth` deps: `better-auth` (latest stable), `drizzle-orm` (latest
  compatible). First ORM in the repo; scoped to the auth worker only.
- Schema island: `apps/auth/src/schema.ts` — snake_case columns, camelCase
  keys, integer-timestamp + boolean modes (Better Auth's canonical shape).
  Author by reconciling `npx @better-auth/cli generate` output against
  `~/Code/releases/workers/api/src/db/schema-auth.ts`, trimmed to our
  plugins.
- Migrations: hand-written SQL in `apps/auth/migrations/`, timestamp-prefixed
  filenames, applied via `wrangler d1 migrations apply DB` (local + remote),
  same flow as `apps/api`.
- **⚠ footgun**: schema.ts ↔ SQL sync is manual. Copy releases' convention:
  JSDoc on each table naming its paired migration file; add a cheap CI check
  if practical.

Tables (phase-dependent): `user`, `session`, `account`, `verification`,
`rate_limit`, `organization`, `member`, `invitation`, `device_code`.

### D3. Plugin set

| Plugin                      | Why                                                                      | Phase |
| --------------------------- | ------------------------------------------------------------------------ | ----- |
| social provider: **GitHub** | primary sign-in                                                          | 1     |
| `magicLink`                 | email sign-in for invitees without GitHub; dev-friendly                  | 1     |
| `admin`                     | global `user.role` (`admin`/`user`); gates the admin UI                  | 2     |
| `organization`              | orgs, members, invitations; `sendInvitationEmail`                        | 3     |
| `bearer`                    | CLI presents session token as `Authorization: Bearer`                    | 4     |
| `deviceAuthorization`       | RFC 8628 device flow for `uploads login`; static client id `uploads-cli` | 4     |

Explicitly **out of scope for v1**: `oauthProvider` (likely near-term — keep
the door open, e.g. don't squat on token prefixes or `/oauth/*` web routes),
email/password, passkeys, One Tap, Stripe, api-key plugin,
`@better-auth/infra` dash/sentinel, custom org access-control roles. Build
`socialProviders` via a gate function (provider omitted unless both id+secret
resolve) so adding Google later is just a secret pair.

Magic link config: 15-min TTL, `storeToken: "hashed"`, delivery via the
`send_email` binding (see D8).

Session config: signed **cookie cache (5 min)** so `get-session` doesn't hit
D1 per request. Rate limiting: `storage: "database"` (D1), **fail-closed in
production** with explicit `AUTH_RATE_LIMIT_DISABLED` dev opt-out (releases
pattern — never couple rate limiting to secret resolution).

### D4. Organizations ↔ workspaces mapping (1:1 now, flexible later)

Today a "workspace" is an admin-provisioned tenant record in KV `REGISTRY`
(`ws:<name>`, see `apps/api/src/workspace.ts`). Decision:

- **One org per workspace**, linked by `organization.slug === workspace
name`. KV record stays the source of truth for storage config/budgets; the
  org is the source of truth for _who belongs to it_.
- **Flexibility for one-org-many-workspaces later**: treat the slug linkage
  as an implementation detail behind one module —
  `apps/api/src/org-workspaces.ts` exposing
  `workspacesForOrg(orgId) → string[]` and `orgForWorkspace(name)`. All API
  code goes through it; today it's a slug lookup, later it can consult a
  mapping table without touching callers. Nothing else may assume 1:1.
- **No personal-org auto-provisioning** (deliberately NOT copying the prior
  repos' `session.create.before` hook). Workspaces are admin-provisioned;
  first sign-in lands in a "no workspace yet" state.
- Org roles: stock `owner`/`admin`/`member`. `member.role` (org) is distinct
  from `user.role` (global admin plugin) — don't conflate.
- Org **invitations** replace today's enrollment magic link for humans:
  invitation email → `https://uploads.sh/accept-invitation/<id>` → GitHub or
  magic-link sign-in → membership. Existing `auth_enrollments` exchange stays
  untouched until Phase 5.

### D5. CLI auth: device flow, then a grant-based token mint

The CLI ultimately needs a `up_<workspace>_…` token (what `workspaceAuth`
and the `/v1/:workspace/*` surface consume). The device flow authenticates
the _user_; a mint endpoint bridges to workspace tokens:

1. `uploads login` (no code): device flow against the auth worker —
   `POST https://auth.uploads.sh/api/auth/device/code` (client_id
   `uploads-cli`), print/open `https://uploads.sh/device?user_code=…`, poll
   `POST …/device/token` honoring `authorization_pending`/`slow_down`/
   `expired_token`.
2. With the session access token (bearer plugin), call
   `POST https://api.uploads.sh/v1/tokens`. The API worker verifies the
   session via the `AUTH` service binding, checks org membership for the
   requested workspace(s) via `/internal/memberships`, then mints via the
   existing `createToken` path (`apps/api/src/auth-db.ts`).
3. CLI stores `UPLOADS_{API_URL,WORKSPACE,TOKEN}` exactly as today
   (`packages/uploads/src/config-file.ts`) — zero change to the rest of the
   CLI/MCP token model.

**Token contract designed for multi-workspace + API-token futures.** Request:

```jsonc
{
  "grants": [{ "workspace": "acme", "scopes": ["files:read", "files:write"] }],
  "label": "zach-laptop",
  "ttlSeconds": 7776000,
}
```

- v1 validation: exactly one grant (reject >1 with a clear "not yet
  supported"), so the wire format never has to break when a token can span
  workspaces or when user-generated API tokens ship.
- Response returns the token once, plus grant metadata. Storage stays the
  existing single-workspace `auth_tokens` row for now; if/when multi-grant
  lands, introduce a `token_grants` join table behind the same endpoint.
- Record the minting user id on the token row (new nullable column) so
  future revocation-by-user and per-user caps are possible.

### D6. Web app (Astro) integration

- Better Auth client: **vanilla** `better-auth/client` (`createAuthClient`)
  — no React in this repo. Client plugins: `magicLinkClient`, `adminClient`,
  `organizationClient`, `deviceAuthorizationClient`. Shared module
  `apps/web/src/lib/auth-client.ts`, baseURL `https://auth.uploads.sh`
  (public env var), `fetchOptions: { credentials: "include" }`.
- New pages (SSR or static+inline-JS following `invite.astro`'s pattern):
  `/login` (GitHub button + magic-link email form), `/device` (user-code
  approval), `/accept-invitation/[id]`, `/admin/*` (Phases 2–3).
- **⚠ repo gotcha**: `apps/web/wrangler.jsonc` uses `run_worker_first` with
  custom `main: src/entry.ts`. Verify every new route with
  `Sec-Fetch-Mode: navigate` fetches (known static-404 failure mode
  otherwise).
- Client-side session gating on admin pages is an affordance only; **the API
  worker is the security boundary** for anything it serves. Admin data
  endpoints on `apps/api` check `user.role === "admin"` via the service
  binding.

### D7. Secrets & env

`apps/auth/wrangler.jsonc`:

- Plain vars: `BETTER_AUTH_URL` (`https://auth.uploads.sh`), `WEB_ORIGIN`
  (`https://uploads.sh`), `ENVIRONMENT`.
- Secrets via **Cloudflare Secrets Store** (`secrets_store_secrets`
  bindings), prefixed `UPL_` (mirrors room-configurator's `RS_` pattern):
  `UPL_BETTER_AUTH_SECRET`, `UPL_GITHUB_CLIENT_ID`,
  `UPL_GITHUB_CLIENT_SECRET`. Resolve through a `resolveSecretValue` helper
  that falls back to a plain same-named env string for tests, and swallows
  store-resolution failures so a missing secret degrades to
  "provider/feature gated off" (or 503 for the signing secret) instead of
  500ing every auth request.
- Bindings: `DB` (D1 `uploads-auth`), `EMAIL` (`send_email`, sender
  `noreply@uploads.sh` — must be added to `allowed_sender_addresses`),
  rate-limiter binding.
- **⚠ footgun** (applies, since we're using Secrets Store): a same-named
  `.dev.vars` string does NOT override an unpopulated store binding under
  `wrangler dev`. Copy releases' `resolveSigningSecret`: distinct
  `BETTER_AUTH_SECRET_DEV` dev var preferred only when the binding is
  unresolvable, and **return 503 from `/api/auth/*` rather than booting on
  an ephemeral secret**.

`apps/api/wrangler.jsonc`: add `services` binding `AUTH → uploads-auth`.
`apps/web`: public `UPLOADS_AUTH_ORIGIN` var alongside existing
`UPLOADS_API_ORIGIN`.

GitHub OAuth app (human task): callback
`https://auth.uploads.sh/api/auth/callback/github` (+ dev app for the local
auth worker origin). Provider construction is gated on both id+secret, so
code merges before the OAuth app exists.

### D8. Future webhooks service — seams to leave

A separate webhooks/eventing service is plausibly next. Don't build it, but:

- Keep **outbound email rendering/sending** in one module of the auth worker
  (`apps/auth/src/email.ts`) with a narrow interface (template + recipient +
  context), so it can later post to a webhooks/notifications service instead
  of calling `send_email` directly.
- Prefer **JWKS/JWT verification** (D1) as the documented path for any new
  service that must trust sessions — the webhooks service should never need
  a D1 binding to auth's database.
- Auth lifecycle events (user created, member added, invitation accepted)
  should flow through Better Auth `databaseHooks` collected in one file, so
  emitting them to an event bus later is a one-file change.

### D9. First-admin bootstrap

- **Primary: seed SQL** — a documented one-off statement
  (`UPDATE user SET role = 'admin' WHERE email = ?`) run via
  `wrangler d1 execute uploads-auth --remote` after the first human signs in.
  Keep it as a checked-in script (`apps/auth/scripts/promote-admin.sql` or
  `.mjs` wrapper) rather than tribal knowledge.
- **Fallback: `ADMIN_TOKEN`-gated promote endpoint** on `apps/api`
  (`POST /admin/users/promote`, body `{ email }`), reusing the existing
  `adminAuth` middleware and calling the auth worker over the service
  binding. Useful when D1 console access is inconvenient (e.g. promoting a
  second admin from CI/ops tooling). Ships in Phase 2 alongside the plugin.

## Phased plan (agent briefs)

Each phase is one PR-sized unit. Repo conventions for all phases:
oxlint/oxfmt, Vitest 4 colocated tests, changesets only for
`@buildinternet/uploads` (private apps are ignored), migrations via
`wrangler d1 migrations apply` with local scripts wrapped in
`run-timed.mjs`, CI runs `pnpm types` first (new worker must ship
`wrangler types` config and land in `.github/workflows/ci.yml` +
`d1-migrations.yml`).

### Phase 0 — prerequisites (human + orchestrator)

- [ ] Zach: create GitHub OAuth apps (prod callback
      `https://auth.uploads.sh/api/auth/callback/github`, plus dev app);
      populate Secrets Store entries `UPL_GITHUB_CLIENT_ID/SECRET` +
      `UPL_BETTER_AUTH_SECRET` (Phase 1 can deploy gated/inert before secrets).
- [x] `uploads-auth` D1 database created 2026-07-12 (id
      `24eb8b7f-5dff-46bc-a1a5-fa436810805d`, region ENAM). The
      `auth.uploads.sh` route and `noreply@uploads.sh` sender allowlist are
      declared in `apps/auth/wrangler.jsonc` and take effect on first deploy.
- [ ] Orchestrator: confirm latest stable better-auth at kickoff (1.7 may
      have landed; if so, re-verify the ⚠ workarounds cited from 1.6.x).

### Phase 1 — new `apps/auth` worker boots with GitHub + magic link

Scope: scaffold `apps/auth` (Hono, wrangler.jsonc, vitest, oxlint wiring,
root package.json filters); better-auth instance factory `createAuth(env)`
memoized per isolate — **⚠ footgun**: the hand-enumerated memo cache key must
include every auth env field; schema island + first SQL migration (core
tables + rate_limit); GitHub social (gated) + magicLink plugins; email module
(`src/email.ts`) using `EMAIL` binding; credentialed CORS for the web origin;
trusted-origins helper + tests; secret resolution with the 503 guard;
`.dev.vars.example`; CI + d1-migrations workflow entries.

Acceptance: local `wrangler dev` → magic-link sign-in round-trips end-to-end
(email captured via local binding stub/log); GitHub flow works with a dev
OAuth app or is provably gated-inert without one; `/api/auth/*` returns 503
when the signing secret is unresolved; unit tests for secret resolution,
trusted origins, CORS; repo-wide lint/test green.

### Phase 2 — web session UI + admin plugin + API session verification

Scope: `admin` plugin + migration (`role`/ban columns);
`apps/web/src/lib/auth-client.ts`; `/login` page (GitHub + magic link);
session indicator + sign-out in the console layout; `AUTH` service binding
in `apps/api` + a `sessionAuth` middleware (forwards Cookie/Authorization to
get-session over the binding) + `requireAdminUser` guard; first-admin
bootstrap per D9 (checked-in seed SQL script + `ADMIN_TOKEN`-gated
`POST /admin/users/promote` fallback); admin-gated `/admin` landing page.

Acceptance: sign in on uploads.sh, cookie valid across `.uploads.sh`;
`apps/api` correctly resolves the session via the binding (integration test
with miniflare service bindings); admin sees `/admin`, non-admin bounced
client-side AND any admin data endpoint rejects server-side; navigation-mode
fetch tests for new SSR routes.

### Phase 3 — organizations, membership, invites

Scope: `organization` plugin + migration (`organization`/`member`/
`invitation`); `sendInvitationEmail` via the email module;
`/internal/memberships` endpoint on the auth worker (service-binding-only
guard); `apps/api/src/org-workspaces.ts` indirection module (D4); one-time
idempotent backfill script creating an org per existing KV workspace
(slug = name; run against `--local` and `--remote`);
`/accept-invitation/[id]` Astro page; admin UI: workspace/org list, members,
pending invites, "invite user to workspace" form (calling admin-gated
endpoints).

Acceptance: admin invites an email → recipient signs in (GitHub or magic
link) → becomes org member; membership visible in admin UI; backfill
idempotent (re-run is a no-op); existing enrollment-code flow untouched and
passing; unit tests on the org-workspaces module both for 1:1 behavior and
its interface contract.

### Phase 4 — CLI device login + grant-based token mint

Scope: `deviceAuthorization` + `bearer` plugins + `device_code` migration
(verify whether the `schema: {}` zod workaround from releases is still needed
on the installed version); `/device` approval page on `apps/web`;
`POST /v1/tokens` on `apps/api` per D5 (grants array, single-grant
validation, minting-user column migration on `auth_tokens`, service-binding
session + membership checks); CLI: `uploads login` gains the no-code device
path — prefer plain `fetch` against the stable OAuth-shaped endpoints over
adding a better-auth client dep to the published package; keep `--code`
enrollment path; changeset for `@buildinternet/uploads`.

Acceptance: end-to-end `uploads login` → browser approval → workspace token
saved → `uploads doctor` green; polling honors `slow_down`/
`authorization_pending`/`expired_token`; `POST /v1/tokens` rejects
multi-grant requests and non-members; MCP smoke unaffected.

### Phase 5 — migration & cleanup

Scope: docs (`docs/admin-tokens.md`, `docs/enrollment.md`,
`docs/workspaces.md`, AGENTS.md auth section) rewritten around Better Auth;
deprecate the admin enrollment-creation path in favor of org invitations
(keep the exchange endpoint until known consumers migrate); decide
ADMIN_TOKEN fate (recommend: keep for scripts/ops; admin _UI/data_ paths
session-only); retention sweep for expired `device_code`/`verification` rows
(cron on the auth worker) if Better Auth doesn't self-clean on D1.

## Open questions

None — all resolved in the decisions log above. Executing agents hitting a
genuinely new decision should stop and surface it to the orchestrator rather
than improvising.

## Reference index (for executing agents)

- This repo: `apps/api/src/index.ts`, `apps/api/src/workspace.ts` (KV
  workspace model), `apps/api/src/auth-db.ts` (D1 tokens/enrollments —
  `createToken` is the mint path), `apps/api/src/routes/{admin,auth}.ts`,
  `apps/api/migrations/`, `apps/api/scripts/run-timed.mjs`,
  `apps/web/src/entry.ts` + `apps/web/wrangler.jsonc` (run_worker_first),
  `apps/web/src/pages/invite.astro` (page pattern),
  `packages/uploads/src/commands/login.ts` + `src/config-file.ts` (CLI),
  `apps/mcp/wrangler.jsonc` (example of a second worker sharing conventions).
- releases: `workers/api/src/auth/index.ts` (config, `resolveSigningSecret`,
  device-auth `schema:{}` workaround, trusted-origins helper),
  `workers/api/src/db/schema-auth.ts` (schema shapes),
  `workers/api/src/auth/workspace.ts` (org provisioning — pattern we're NOT
  copying, see D4), `workers/api/migrations/`.
- room-configurator: `apps/api/src/betterauth/{index.ts,schema.ts,organization.ts,email.ts}`,
  `apps/api/migrations/0005_better_auth.sql`, `apps/web/lib/auth-client.ts`.
- Docs: better-auth plugins — device-authorization, organization, admin,
  magic-link (https://www.better-auth.com/docs); `@better-auth/cli generate`
  for schema reconciliation.
