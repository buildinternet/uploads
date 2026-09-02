# Operator runbook

Day-to-day ops for **uploads.sh**. Secrets stay out of git.

## Workspace limits

```bash
pnpm workspace:limits <name>
pnpm workspace:limits <name> \
  --max-storage 25GB \
  --max-uploads-per-month 10000 \
  --max-upload-bytes 25MB \
  --max-video-bytes 25MB \
  --retention-days 90 \
  --allowed-prefixes default \
  --max-key-depth 8
```

Suggested **shared/agent** defaults: 25 GB storage, 10k uploads/month, 25 MB images, 8 MB video, key prefixes `default` (`f/`, `screenshots/`, `gh/`), max depth 8 — **no retention** (PR/issue embeds should stay put). **Throwaway** (opt-in): 1 GB / 1k / 15 MB / 5 MB video / 90-day retention / same key policy.

**New workspaces** (`pnpm workspace:add`) apply the shared/agent template
automatically (source: `apps/api/scripts/workspace-limit-defaults.json`). Pass
`--no-default-limits` to start unlimited, or override individual fields with the
usual `--max-*` flags (`unlimited` clears one field). Add retention only when
you want expiry: `--retention-days 90`. Existing workspaces are unchanged until
you run `workspace:limits`.

`--allowed-prefixes default` expands to the typed destinations agents already use. Clear with `--clear-allowed-prefixes` / `--clear-max-key-depth`. Puts outside the allowlist return **400** `key_prefix_not_allowed`; too-deep paths return **400** `key_too_deep`.

KV cache ~60s. Agents: `uploads usage`.

## Dual public hosts (stable vs embed / GitHub Camo)

Shared-bucket objects are available on two custom domains of `uploads-default`
(same keys, same bytes):

| Host                                           | Role                                                  | Cache-Control (origin)                                                |
| ---------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| `storage.uploads.sh` (also `store.uploads.sh`) | Durable public URL                                    | Object metadata: `public, max-age=60`                                 |
| `embed.uploads.sh`                             | GitHub / Camo embeds that may be overwritten in place | Zone Transform Rule: `max-age=0, no-cache, no-store, must-revalidate` |

**Why:** GitHub proxies external images through Camo. Short `max-age` alone is
not enough for reliable hot-swap; badge-style no-cache headers on a dedicated
host are. See [#152](https://github.com/buildinternet/uploads/issues/152).

**Setup (once per account):**

1. R2 → `uploads-default` → Custom Domains → connect `embed.uploads.sh` (same
   zone as `uploads.sh`).
2. Rules → Transform Rules → Modify Response Header:
   - When: `http.host eq "embed.uploads.sh"`
   - Set: `Cache-Control` =
     `max-age=0, no-cache, no-store, must-revalidate`

**API / CLI:** put, list, head, and gallery items return `url` (stable) and
`embedUrl` (embed twin when the workspace `publicBaseUrl` host is
`storage.uploads.sh` / `store.uploads.sh`). CLI/MCP markdown and the managed
attachments comment prefer `embedUrl` for `<img src>`.

**Overrides (self-host):**

| Side         | Variable                        | Behavior                                                                                                   |
| ------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Worker       | `EMBED_PUBLIC_BASE_URL`         | Unset → default embed host for known storage hosts; empty → never emit `embedUrl`; URL → use as embed base |
| CLI / client | `UPLOADS_EMBED_PUBLIC_BASE_URL` | Same semantics client-side (also used if an older API omits `embedUrl`)                                    |

No Worker proxies image bytes — dual host is DNS + zone rules only.

## SVG and XML on the hosted hosts (issue #929)

**Applied 2026-09-02** (zone ruleset `1b295145ce4a4dc685498657af8a6956`, phase `http_response_headers_transform`, via the API):

| Rule id                            | What                                                                                                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `030fcb7edf324c0b9c966550c8b7d870` | `X-Content-Type-Options: nosniff` on every response from the three storage hosts                                                                                                                            |
| `508226d5de4a4a0d8d861356b43cf912` | `Content-Security-Policy: … sandbox` + `nosniff` when the response content type is `image/svg+xml`, `application/xml`, or `text/xml` (the `eq` form; the zone is on Pro, so regex `matches` is unavailable) |

The operator probe returned `ok: true` for all three hosts the same day. The `active-content-uploads` flag was still off at that point.

SVG and XML (`image/svg+xml`, `application/xml`, `text/xml`) are gated
uploads: a lane only accepts them once its public host is **verified** to
serve them behind a sandboxing Content-Security-Policy — these are bare R2
custom domains with no Worker in front, so a malicious SVG's script would
otherwise run with an origin. See
`docs/superpowers/specs/2026-09-02-svg-xml-active-content-design.md` for the
full design; `apps/api/src/active-content.ts` is the gate every write path
checks, `apps/api/src/active-content-hosts.ts` is the hosted-lane half below.

**Setup (once per hosted host — `storage.uploads.sh`, `store.uploads.sh`,
`embed.uploads.sh`):**

1. Rules → Transform Rules → Modify Response Header:
   - When — **validate this expression in the rule editor before relying on
     it**; the editor's own syntax check catches an unescaped `+` or a plan
     that can't evaluate it before the rule ever ships:
     ```
     (http.host in {"storage.uploads.sh" "store.uploads.sh" "embed.uploads.sh"}) and (any(http.response.headers["content-type"][*] matches "^(image/svg\\+xml|application/xml|text/xml)"))
     ```
     The `\+` is written `\\+` here because the Rules language, like most
     expression languages, needs its own escape character escaped inside a
     double-quoted string — a lone `\+` is a syntax error in the editor.
     `matches` (regex) on response headers needs a Cloudflare plan with
     regex support in Transform Rules; if the zone doesn't have one, use this
     equivalent expression instead, which needs no regex:
     ```
     (http.host in {"storage.uploads.sh" "store.uploads.sh" "embed.uploads.sh"}) and (any(http.response.headers["content-type"][*] eq "image/svg+xml") or any(http.response.headers["content-type"][*] eq "application/xml") or any(http.response.headers["content-type"][*] eq "text/xml"))
     ```
   - Set:
     - `Content-Security-Policy` =
       `default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox`
     - `X-Content-Type-Options` = `nosniff`

   Set exactly **one** `Content-Security-Policy` header. Two CSP response
   headers are legal CSP, but `Headers.get` joins repeated headers with a
   comma and the probe (`parseSandboxCsp`) splits directives on `;` only — so
   a policy split across two headers fails the check.

   The rule must cover **XML as well as SVG**. The expression above already
   lists `application/xml` and `text/xml`; an extension-scoped variant
   (`ends_with ".svg"`) would pass an SVG-only probe while leaving XML
   documents free to run script through an `<?xml-stylesheet>` XSLT. The
   probe writes both an SVG and an XML object and requires both to come back
   sandboxed, so a rule that misses XML now fails outright.

2. Confirm it worked:
   ```bash
   curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
     https://api.uploads.sh/admin/active-content/probe
   ```
   Check the response: all three hosts (`storage.uploads.sh`,
   `store.uploads.sh`, `embed.uploads.sh`) must read `ok: true`. **Every one of
   them**, not just the one a given workspace's URLs name — `storage.` and
   `store.uploads.sh` are two custom domains of the same bucket (same keys,
   same bytes), so the gate closes for every shared-lane workspace as soon as
   any hosted host's record is missing, failing, or stale. Then spot-check the
   headers directly against a real `.svg` and a real `.xml` on each host:
   ```bash
   curl -I https://storage.uploads.sh/<workspace-prefix>/<some-key>.svg
   curl -I https://store.uploads.sh/<workspace-prefix>/<some-key>.svg
   curl -I https://embed.uploads.sh/<workspace-prefix>/<some-key>.svg
   curl -I https://storage.uploads.sh/<workspace-prefix>/<some-key>.xml
   ```

**Daily sweep:** the Worker's `scheduled` handler (`0 6 * * *`, `index.ts`)
calls `runActiveContentHostSweep` for every hosted host, writing
`host-active-content:<host>` to `REGISTRY` as `{ ok, verifiedAt, detail? }`.
Each probe writes an inert SVG _and_ an inert XML object under
`_internal/uploads-verify/`, fetches both back through the host, and deletes
them; the record is `ok` only when both pass. `activeContentAllowed`
(`active-content.ts`) treats a record older than 48h as untrusted — one
missed cron tick doesn't flip every workspace on that host off, but a
genuinely broken Transform Rule closes the gate within two days.

The same `scheduled` handler's retention sweep also reaps any
`_internal/uploads-verify/` object older than 24h from the shared bucket, so
a probe whose own cleanup failed can't accumulate.

**On-demand probe:** two equivalent routes run the same sweep immediately, so
a just-applied Transform Rule can be confirmed without waiting for the next
cron tick — both return the fresh per-host records, each also persisted to
`REGISTRY`, same as the cron: `POST /admin-ui/active-content/probe` (session,
global admin — reachable from the `/admin` panel) for a logged-in operator,
and `POST /admin/active-content/probe` (the `curl` above — `ADMIN_TOKEN` or
an `operator:write` scoped token) for scripted/CI use.

**Kill switch:** Flagship flag `active-content-uploads`, same app as
`video-poster-generation` above:

```bash
wrangler flagship flags update 8371bfe7-9767-4b4d-b75a-37b94d2724f7 \
  active-content-uploads --default off
```

Fails closed like the poster flag — a missing binding, a disabled flag, or a
thrown evaluation are all indistinguishable from "off"
(`activeContentAllowed`). A BYO lane's own verification is unaffected by
this Transform Rule: its owner sets the headers on their own host, and its
`storageActiveContentVerifiedAt` stamp comes from the lane-verify pipeline
or the settings page's "Check now" button, never this sweep.

## Cloudflare error pages

Errors Cloudflare produces itself never reach `apps/web`, so the Astro
`404.astro` / `500.astro` pages cannot cover them. Without configuration those
render as generic Cloudflare pages — including a 27 KB "Not Found" with a
cloudflare.com favicon for any dead link on `storage.uploads.sh` /
`embed.uploads.sh`, which are exactly the URLs the CLI hands out.

Two mechanisms, both driven from `scripts/cf-error-pages/`:

| Mechanism          | Covers                                                                                    | Where it lives         |
| ------------------ | ----------------------------------------------------------------------------------------- | ---------------------- |
| Error Pages        | Errors Cloudflare generates: 5xx/1xxx classes, WAF and IP blocks, rate limits, challenges | `PAGES` in `pages.mjs` |
| Custom Error Rules | Errors an **origin** returns — R2 404 and 400 on the three storage hosts                  | `RULES` in `pages.mjs` |

```bash
node scripts/cf-error-pages/build.mjs      # render dist/*.html (gitignored)
node scripts/cf-error-pages/deploy.mjs --dry-run
node scripts/cf-error-pages/deploy.mjs     # upload to R2 + configure the zone
node scripts/cf-error-pages/deploy.mjs --revert   # back to Cloudflare defaults
```

Notes:

- Pages are **self-contained** — no font, image, or stylesheet fetches. The
  "origin is unreachable" page cannot depend on the origin. Design tokens are
  inlined from `packages/ui`; keep them in sync by hand.
- Each page carries its Cloudflare token (`::CLOUDFLARE_ERROR_500S_BOX::`,
  `::CAPTCHA_BOX::`, …) verbatim; Cloudflare rejects the upload without it.
- HTML is stored at content-addressed `_internal/cf-error-pages/` keys, so a
  re-deploy of unchanged bytes is a no-op and Cloudflare never re-fetches a URL
  whose contents moved underneath it (same discipline as the email mark).
- The custom error rules are scoped to `storage.` / `store.` / `embed.uploads.sh`
  on purpose: `uploads.sh` already serves its own branded 404, and the
  `api.` / `auth.` / `agents.` hosts must keep returning JSON error envelopes.
- `waf_challenge` (the legacy WAF captcha) is not settable on the Pro plan.
  Cloudflare answers `success: true` and keeps the default; `deploy.mjs` reads
  each page back and reports that as `SKIPPED` rather than a false success. The
  challenge visitors actually get is `managed_challenge`, which is customized.
- Token scopes: Zone → Custom Pages → Edit, Zone → Config Rules → Edit,
  Account → Workers R2 Storage → Edit.

## Ledger + retention

```bash
uploads usage
uploads reconcile          # storage is truth
uploads purge-expired      # needs retentionDays
```

The API worker also runs a **daily cron** (`0 6 * * *` UTC) that purges every workspace with `retentionDays` set. Logs: `retention_sweep` JSON. This is
the only deletion-capable cron task on the worker — branch-staged GitHub
attachments have no dedicated cleanup by design (a `promoted-at`+7d reaper
shipped in #314 and was retired in #421; see `docs/deletion.md`). The
scheduled handler also runs `runObservabilityRetention` (telemetry/enrollment
row purge, not object storage) alongside the sweep.

The same sweep also finalizes soft-deleted workspaces (see below): once a
workspace's grace window elapses, the sweep runs the full hard teardown and
replaces its `ws:<name>` KV record with a permanent purged tombstone. That
work is logged separately per workspace as `workspace_purged` and rolled up
into the sweep's `workspacesFinalized` field.

After the workspace pass, the sweep also runs an **orphaned auth-org pass**
(#250): it lists every org over the auth worker (`GET /internal/orgs`) and
force-deletes any whose slug has no `ws:<slug>` KV key at all, or only a
purged tombstone — the multi-member orgs left behind by hard/finalized
workspace teardown (see "Auth org deletion" in `docs/deletion.md`). A
soft-deleted workspace still inside its grace window is never treated as an
orphan. The sweep isolates an AUTH outage or a single org's delete failure
(logged, sweep continues) rather than failing the run. Results roll up into the
sweep's `orgsSwept` field.

## Inspecting a workspace

`GET /admin/workspaces/:name` reads one workspace record — storage placement,
plan, limits, key policy, and its soft-delete state:

```bash
curl https://api.uploads.sh/admin/workspaces/acme \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

A soft-deleted workspace comes back with `deletedAt`/`purgeAt` set rather than
404'ing, so this is how you check whether a record is still inside its grace
window and restorable. Only a workspace that never existed, or one already
finalized to a purged tombstone, 404s `workspace_not_found`.

Credentials are never returned: `secretAccessKey`/`accessKeyId` collapse to a
`hasHttpCredentials` boolean, and tokens list their labels and creation times
without the hashes.

There is no list or search here by design — cross-workspace discovery from
client credentials stays closed (#183). This is the operator surface, where the
same token can already delete the workspace it names. `/admin-ui/workspaces`
lists every workspace for the admin dashboard, but it is session-gated
(`requireAdminUser`) and unavailable to `ADMIN_TOKEN` holders.

## Workspace deletion, restore, and finalization

`DELETE /admin/workspaces/:name` is **soft by default** (#247): it stamps
`deletedAt`/`purgeAt` (14-day grace window, `WORKSPACE_DELETE_GRACE_DAYS`) on
the KV record and puts it back. Access denies at the record layer: every
auth/serving path treats a `deletedAt` record as not found. This is subject to
the 60-second KV `cacheTtl` on workspace reads, so token auth may keep
succeeding for up to a minute after deletion (see `docs/deletion.md`). It leaves
R2 objects, file metadata, and galleries untouched. Deleting an already-soft-deleted
workspace 409s `already_deleted` with the existing `purgeAt`.

```bash
curl -X DELETE https://api.uploads.sh/admin/workspaces/acme \
  -H "authorization: Bearer $ADMIN_TOKEN"
# → { "ok": true, "workspace": "acme", "mode": "soft", "deletedAt": "…", "purgeAt": "…" }
```

**Restore** within the grace window clears `deletedAt`/`purgeAt`:

```bash
curl -X POST https://api.uploads.sh/admin/workspaces/acme/restore \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

404s if the workspace never existed or was already finalized (purged
tombstone), 409 `not_deleted` if it isn't currently soft-deleted, and 410
`grace_expired` once `purgeAt` has passed — restorability never depends on
whether the sweep has actually run yet.

**Break-glass hard delete** (`?hard=1`) skips the grace period entirely:
immediate permanent teardown (R2 objects, `file_metadata` + galleries rows,
best-effort auth-org delete, then the KV key removed outright). Non-empty
workspaces still need `?force=1` on top, same as before. This is the only
path that frees a slug for reuse — every other path (soft delete → grace
period → sweep finalization) leaves a permanent `{ status: "purged" }`
tombstone under `ws:<name>` so the name can never be re-registered.

See [docs/deletion.md](deletion.md) for the full cross-surface deletion
policy and rationale.

## Self-serve workspace deletion (#249)

`DELETE /v1/workspaces/:name` and `POST /v1/workspaces/:name/restore` give a
signed-in owner the same soft-delete/restore surface as the admin path
above, session-authed (browser cookie) instead of `ADMIN_TOKEN`. Ownership
gate: the record must have `selfServe === true`, and the caller must be
either the record creator (`createdByUserId` match) or hold org role
`owner` (not `admin`) in that workspace's org (#265, via `isWorkspaceOwner` —
the same membership lookup the #262 governance gates use). Anything else
403s `not_owner`. Semantics are otherwise identical to the
admin soft-delete/restore path (409 `already_deleted` / `not_deleted`, 410
`grace_expired`, never hard, never frees the slug) via a shared stamp helper
so the two paths can't drift. No web console UI yet — API only.

## Backfill gh metadata

One-time script for objects uploaded under `gh/...` before per-file metadata
existed — derives `gh.repo` / `gh.kind` / `gh.number` / `gh.ref` from each key
and PATCHes it in, matching what `uploads attach` now writes going forward.
Idempotent (safe to re-run) and paginates the whole `gh/` prefix itself.

```bash
node --env-file=.env apps/api/scripts/backfill-gh-metadata.mjs --dry-run
node --env-file=.env apps/api/scripts/backfill-gh-metadata.mjs
```

`UPLOADS_API_URL` / `UPLOADS_WORKSPACE` / `UPLOADS_TOKEN` come from `.env`
(same names as `.env.example`); `--workspace <name>` overrides the workspace
for one run. Test against a local `wrangler dev` stack first — never point
this at production while testing.

## Account linking (issue #233)

A person can end up with two Better Auth users for one identity: a
magic-link user (created the first time they signed in by email) and a
separate GitHub-originated user, if their GitHub email differs from — or was
entered before — the magic-link address. Unlinked, the GitHub user looks
"brand new" to OAuth/consent flows and gets routed into workspace creation
even though a workspace already exists under the other user.

Policy (`apps/auth/src/auth.ts`, `account.accountLinking`):

- Linking is **enabled**, and only ever happens on a **verified** email.
  Completing a magic-link sign-in counts as verifying that address (`better-auth`'s
  `magicLink` plugin sets `emailVerified: true` on verify); a GitHub sign-in
  or explicit "Connect" whose GitHub-reported email is verified and matches
  an existing user's email attaches to that user instead of creating a
  second one.
- An **unverified** GitHub email never links, full stop — this is
  deliberately not bypassed by `trustedProviders`. Verified against
  better-auth 1.6.23's actual implementation:
  `trustedProviders` skips the provider-email-verified check entirely, so
  listing `"github"` there would let an unverified GitHub email auto-link —
  the exact account-takeover vector the issue calls out. `trustedProviders`
  is left empty on purpose; see the comment in `auth.ts` for detail.
- `allowDifferentEmails: true` covers the common case where the GitHub email
  differs from the magic-link address, for both the implicit (sign-in) and
  explicit (`/account/profile` "Connect") linking paths.

For someone who already ended up split across two users: sign in as either
identity, go to `/account/profile` → "Sign-in methods" → **Connect** GitHub
(or magic-link, if the other side already has GitHub). The OAuth consent
page's "you don't have a workspace yet" panel and the profile page both hint
at this so it's discoverable without operator intervention. There is no
backfill/merge tool for users who linked before this policy shipped — that
would need a one-off migration script if it comes up.

## Invitations and people

Workspace org roles are **owner**, **admin**, and **member** (Better Auth
`member.role`, not the global site-admin `user.role`). The account UI people
tab is `/account/workspaces/<name>/people` (legacy `/invite` redirects there).

### Who can manage people

| Action                                               | Owner | Admin |
| ---------------------------------------------------- | ----- | ----- |
| Invite teammates; revoke pending invites             | ✅    | ✅    |
| Remove a `member`; promote/demote `member` ↔ `admin` | ✅    | ✅    |
| Remove or demote another `admin`                     | ✅    | ❌    |
| Change the `owner` role, or act on yourself          | ❌    | ❌    |

Enforced in the auth worker (`memberManageDenied`); full detail in
[people-tab design](superpowers/specs/2026-07-19-people-tab-member-management-design.md).

### Workspace admins (normal path)

People with org role **admin** or **owner** on a workspace invite teammates
without `ADMIN_TOKEN` or a global site-admin role:

- **Web:** `/account/workspaces/<name>/people` → Invite section (session
  cookie → `POST /me/workspaces/:name/invites`). Same page for pending invites,
  role changes, and remove.
- **CLI:** `uploads invite create --email teammate@example.com --workspace <name>`
  (device login as the inviter, then the same `/me/…/invites` API)

Both return an **accept URL** (`/accept-invitation/:id`). On hosted uploads.sh,
Cloudflare Email Sending also emails that link. **Self-hosted without an `EMAIL`
binding:** no mail is sent — share the accept URL yourself (UI shows it; CLI
prints it; auth worker logs it). The invitee opens the link, becomes an org
member, and runs `uploads login`.

### Site operators (global admin)

Signed in as a global admin (`user.role === "admin"` — see
`apps/auth/README.md#first-admin`), the **`/admin`** UI can invite any workspace
via `POST /admin-ui/workspaces/:name/invites`. Use this for bootstrap or when
you are not an org member of the workspace.

A workspace needs an organization behind it before it can be invited into — see
the org backfill note in `docs/superpowers/plans/2026-07-12-better-auth-introduction.md`
(Phase 3) if a workspace predates Better Auth and has no org yet.

### Alternative: `ADMIN_TOKEN` enrollment invites (invite links/codes)

Operators can also mint single-use enrollment codes behind `ADMIN_TOKEN`. This
is a secondary path retained for cases where you want to share a code or link
without needing the recipient's email address in advance — org invitations
above remain the primary, recommended way to onboard someone whose email you
know. `uploads login --code` honors codes issued this way, and the `/admin`
panel's per-workspace "Generate invite link" button mints the same records
through the session-authed `/admin-ui` counterpart.

```bash
ADMIN_TOKEN=<admin-credential> uploads admin invite create \
  --workspace acme --label early-adopter
```

By default the command prints one **magic link** (`…/invite?id=…#code=…`): the
single-use code rides in the URL fragment, so share the link over a single trusted
channel and treat it like a password. Add `--separate-code` for two-channel output—a
non-secret page URL plus a code you deliver separately—when a deployment prefers it.
Pass `--email <address>` to deliver the link by email instead of printing it—sent
from `invites@uploads.sh` via Cloudflare Email Sending (`uploads.sh` is onboarded).
Delivery is rate-limited per recipient and audit-logged (`invite_emailed`) with only
the workspace, recipient, and page id—never the code or link. If delivery fails the
invite is still created and the CLI prints the link as a fallback.
The admin API at `POST /admin/enrollments` returns the same fields. Invitation codes
default to a 2-hour expiry (configurable at creation with `--expires-in`, from 60
seconds up to 24 hours) and are consumed by one successful exchange. Unknown,
expired, and consumed codes return the same public error shape.

The invite page shows the target workspace and expiry, and loads no analytics or
third-party assets. Response controls request `no-store`, `no-referrer`, `noindex`, a
restrictive CSP, and disabled browser permissions. The code lives only in the URL
fragment—never the query string—so it stays out of server logs and referrers, and the
page reads it client-side without sending it anywhere.

## Authenticated local stack

For the real local browser path, run:

```bash
pnpm dev:stack
```

It bootstraps the local state, starts Auth (`127.0.0.1:8788`), API (`:8787`),
and Web (`:4321`), registers the dedicated `dev-demo` workspace, uploads nested
PNG fixtures, and prints a JSON readiness record only after the end-to-end smoke
test passes. Open `http://127.0.0.1:4321/account/workspaces`.
That exact account page creates the local-only demo session automatically, then
loads the workspace as the ordinary `dev-demo` member.

Use these non-interactive checks for an agent or CI-like local verification:

```bash
pnpm dev:stack:check --json
pnpm dev:stack:smoke
```

Both prove `dev session → get-session → /me/workspaces → dev-demo file listing`
with a cookie jar. They exercise the real Better Auth cookie, API service binding,
membership lookup, workspace prefix, and local R2—not a mock API. `dev-demo` is
the only workspace overwritten by the stack; `default` has no local Better Auth
membership in this stack, so it isn't used for browser enumeration here. Fixture object previews intentionally remain out of
scope because simulated R2 objects do not exist at `storage.uploads.sh`.

The zero-input `POST /api/auth/dev-session` route is absent unless `dev:stack`
supplies its ephemeral `LOCAL_STACK=true` Worker variable, the environment is
development, and Auth/Web use the exact `127.0.0.1` origins above. It seeds an
ordinary member and uses Better Auth's normal session/cookie path; API membership
and file authorization remain unchanged. Do not add that flag to `.dev.vars`.

Stop the stack with <kbd>Ctrl-C</kbd>. Its supervisor sends TERM then KILL to each
Worker process group. If an interrupted shell still leaves a process behind, inspect
it before killing it as described below.

## Local Wrangler gotchas

`wrangler … --local` starts miniflare against `apps/api/.wrangler/state`. Since
uploads#754 item 1, `apps/auth`'s local `wrangler dev` (see `pnpm dev:stack` /
`scripts/dev-stack.mjs`) is started with `--persist-to ../api/.wrangler/state`
so it points at this same directory instead of getting its own empty local
D1 — both workers' local dev shares the one merged database. That is
fine for short interactive use, but:

1. **Agent timeouts orphan the process.** If a coding agent kills only the shell
   wrapper, the Node/wrangler child reparents to PID 1 and can keep running.
2. **Hangs can balloon RAM.** A stuck `wrangler kv key get … --local` has been
   observed past **10–17 GB** while spinning in exception/stack formatting.
3. **Existence checks do not need wrangler.** Local REGISTRY keys live in
   miniflare SQLite under
   `apps/api/.wrangler/state/v3/kv/miniflare-KVNamespaceObject/*.sqlite`
   (`_mf_entries.key`). `pnpm doctor` / `pnpm bootstrap` use
   `scripts/lib-local.sh` to read that first, with a **~20s timed** wrangler
   fallback only when `sqlite3` is missing.

**Do this instead of bare ad-hoc checks:**

```bash
pnpm doctor                    # “is default registered?”
pnpm workspace:limits default --local   # already time-bounded
pnpm --filter @uploads/api run migrate:d1:local   # 60s cap via run-timed.mjs
# or, if you must call wrangler by hand (group-kills hung miniflare on deadline):
node apps/api/scripts/run-timed.mjs 20 -- \
  pnpm --filter @uploads/api exec wrangler kv key get ws:default \
  --binding REGISTRY --local
```

Workspace scripts (`workspace:add`, `workspace:limits`) and local D1 migrate
use `apps/api/scripts/run-timed.mjs` so a hung miniflare cannot run forever.

**If memory creeps again**, look for orphans first:

```bash
pgrep -fl 'wrangler.*(kv|d1).*--local'
# confirm PID, then:
kill <pid>          # escalate to kill -9 only if needed
```

Avoid concurrent `wrangler --local` against the same state while one is hung —
SQLite WAL/SHM files under `.wrangler/state` are what miniflare locks.

## Secrets

Every secret belongs to one or more **named Workers**, and `wrangler secret put`
sets it on exactly one of them. A secret that two Workers read must be installed
on both, with byte-identical values. Nothing in Cloudflare enforces that, so this
table is the source of truth. Keep it current when a Worker starts or stops
reading a secret.

| Secret                           | Workers                            | Purpose                                                                                           |
| -------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `WORKSPACE_SECRETS_KEY`          | **`uploads-api` + `uploads-mcp`**  | **Current** KEK for BYO credentials in KV (`enc:v1:…`)                                            |
| `WORKSPACE_SECRETS_KEY_PREVIOUS` | **`uploads-api` + `uploads-mcp`**  | **Previous** KEK during rotation only (decrypt fallback, then remove from both)                   |
| `GITHUB_APP_PRIVATE_KEY`         | **`uploads-api` + `uploads-mcp`**  | GitHub App identity (PKCS#8 PEM). Both Workers post managed comments in-process.                  |
| `BILLING_INTERNAL_KEY`           | **`uploads-api` + `uploads-auth`** | Shared key gating `POST /internal/billing/plan`. The two values must match.                       |
| `ADMIN_TOKEN`                    | `uploads-api`                      | `/admin/*` — break-glass ops/CI use, not routine admin work (see [admin-tokens](admin-tokens.md)) |
| `ANALYTICS_API_TOKEN`            | `uploads-api`                      | Analytics Engine SQL API token for the `/admin/metrics` breakdown panel                           |
| `GITHUB_APP_WEBHOOK_SECRET`      | `uploads-api`                      | HMAC secret for GitHub App webhook deliveries (`X-Hub-Signature-256`)                             |
| `OPENAI_APPS_CHALLENGE`          | `uploads-mcp`                      | Domain-verification token served at `/.well-known/openai-apps-challenge`                          |
| The eight in `secrets.required`  | `uploads-auth`                     | Better Auth, GitHub OAuth, Stripe, billing — listed in `apps/auth/wrangler.jsonc`                 |

`uploads-web` reads no secrets. Absence behavior for each of the above is in
[Minimal-binding profile](#minimal-binding-profile-self-hosting-uploads754-item-3).

**Why `uploads-mcp` needs the same KEK.** The hosted MCP worker resolves BYO
storage in-process — it imports `@uploads/api/storage` rather than proxying to
`uploads-api` — so it opens the same `enc:v1:…` ciphertext with its own copy of
the key. A shared-lane (binding-mode) workspace never touches the key ring, so a
missing KEK on `uploads-mcp` is invisible until the first BYO workspace calls a
storage tool, and then every such call 503s. This gap was live in production
until 2026-08-27.

```bash
# Generate
openssl rand -base64 32

# First-time install (production) — BOTH workers, the SAME value
pnpm --filter @uploads/api exec wrangler secret put WORKSPACE_SECRETS_KEY
pnpm --filter @uploads/mcp exec wrangler secret put WORKSPACE_SECRETS_KEY
```

Paste the value identically on both. The KDF hashes the raw string, so one
trailing newline or space silently breaks decrypt on that Worker only.

`workspace:add --bucket …` encrypts keys when `WORKSPACE_SECRETS_KEY` is in the env. Plaintext legacy values still work until re-written. Decrypt tries **current**, then **previous**, so rotation does not brick BYO workspaces mid-cutover.

**Verify both Workers hold it** (read-only — `wrangler secret list` prints names,
never values):

```bash
pnpm --filter @uploads/api exec wrangler secret list
pnpm --filter @uploads/mcp exec wrangler secret list
```

If a Worker is missing the key, its logs carry
`secrets_key_unconfigured_on_read` on the first BYO request, and the API answers
503 `secrets_key_unconfigured`. That error deliberately does **not** tell the
user to reconfigure storage: re-entering credentials re-seals them with
`uploads-api`'s key, and the Worker that lacks the key still cannot read them.
A 503 `storage_credentials_unreadable` is the different case — a key was
present but did not open the ciphertext — and reconfiguring does fix that one.
A skipped fallback lane logs `storage_lane_skipped` with the same `code`.

### Rotating `WORKSPACE_SECRETS_KEY`

**Putting secrets** is always `wrangler secret put` (the Worker config).
**Re-sealing records** is an **admin API** so the KEK stays on the worker (not in shell history).

Rotate on **every Worker that reads the key** — `uploads-api` and `uploads-mcp`
today (see the table above). Rotating only `uploads-api` breaks the hosted MCP
for every BYO workspace the moment you delete the previous key.

1. Generate a new key: `openssl rand -base64 32` → keep OLD and NEW.
2. Install both on **both** Workers. Use one `secret bulk` call per Worker so
   each Worker never has a half-rotated pair:
   ```bash
   printf 'WORKSPACE_SECRETS_KEY_PREVIOUS=%s\nWORKSPACE_SECRETS_KEY=%s\n' "$OLD" "$NEW" \
     | pnpm --filter @uploads/api exec wrangler secret bulk
   printf 'WORKSPACE_SECRETS_KEY_PREVIOUS=%s\nWORKSPACE_SECRETS_KEY=%s\n' "$OLD" "$NEW" \
     | pnpm --filter @uploads/mcp exec wrangler secret bulk
   ```
   Do `uploads-api` first, then `uploads-mcp`. Between the two calls both
   Workers can still decrypt, because each holds OLD as its previous key.
3. Re-seal registry credentials under the **current** key:
   ```bash
   # dry-run
   curl -XPOST -H "Authorization: Bearer $ADMIN_TOKEN" \
     'https://api.uploads.sh/admin/credentials/reencrypt?dryRun=1'
   # live
   curl -XPOST -H "Authorization: Bearer $ADMIN_TOKEN" \
     https://api.uploads.sh/admin/credentials/reencrypt
   # or: pnpm workspace:reencrypt-secrets --dry-run
   ```
   The re-seal runs on `uploads-api` only. It rewrites KV, which both Workers
   read, so `uploads-mcp` needs no separate re-seal — it only needs the key.
4. Verify BYO on **both** origins, not just the API. Call a storage-touching
   hosted-MCP tool (`list`) against a BYO workspace as well as an
   `api.uploads.sh` read. Logs may show `credential_decrypted_with_previous_key`
   until re-seal finishes.
5. Drop the previous secret from **both** Workers:
   ```bash
   pnpm --filter @uploads/api exec wrangler secret delete WORKSPACE_SECRETS_KEY_PREVIOUS
   pnpm --filter @uploads/mcp exec wrangler secret delete WORKSPACE_SECRETS_KEY_PREVIOUS
   ```

Do **not** delete PREVIOUS before re-encrypt completes, and do not delete it from
either Worker until step 4 passes on both origins.

### Auth worker: dedicated D1 → merged D1 cutover (uploads#754 item 1)

Two changes landed in sequence:

- **Phase 1** (#755): a consolidated migration folding Better Auth's schema
  into `apps/api/migrations` (idempotent — safe on prod's main DB, where
  those tables didn't exist yet), plus test/tooling updates. `apps/auth`
  kept running against its own dedicated `uploads-auth` D1 in production; the
  new tables sat empty and unused in `uploads-production` until cutover.
- **Phase 3 (this cutover)**: `apps/auth/wrangler.jsonc`'s D1 binding (both
  the top-level block and the `previews` block) now points at the same
  database `apps/api` uses (`uploads-production` / `uploads-preview`).
  `apps/auth/migrations/` and the auth-only `d1-migrations-auth.yml` workflow
  are deleted — `apps/api/migrations` plus `d1-migrations.yml` is the only
  migration chain and workflow left in the repo. The code in this cutover is
  safe to merge on its own (an empty-of-real-rows deploy would just mean a
  signed-out worker until the data move runs), but the **operator sequence
  below must happen close together** so there is no window where the worker
  is live against a database that doesn't have the real rows yet.

**Operator sequence** (weekend / low-usage window recommended):

1. **Back up both databases** before touching anything:

   ```bash
   wrangler d1 export uploads-auth --remote --output=uploads-auth-backup-$(date +%Y%m%d).sql
   wrangler d1 export uploads-production --remote --output=uploads-production-backup-$(date +%Y%m%d).sql
   ```

2. **Confirm the Phase 1 migration already applied** to `uploads-production`
   (it did automatically, on #755 merging to main — `wrangler d1 migrations
list uploads-production --remote` should show
   `20260822120000_auth_tables.sql` as applied, nothing pending).

3. **Merge this cutover PR to main.** `d1-migrations.yml` re-runs (a no-op —
   nothing new to apply) and Workers Builds deploys `apps/auth` with its new
   D1 binding. From this point until step 4 finishes, the auth worker is live
   against `uploads-production`'s (still-empty) auth tables — sign-in/sessions
   are effectively down for that window. Merge and immediately run step 4;
   don't let time pass between them.

4. **Run the data move**, from a repo checkout with both databases'
   credentials available:

   ```bash
   node scripts/auth-d1-data-move.mjs --remote
   ```

   Confirm the printed primary-key verification is `OK` for every table
   before considering the cutover complete. If any table reports `MISMATCH`,
   stop and investigate before doing anything else — do not repeat the run
   blindly (see the script's `oauth_client` seed-row handling before assuming
   a second run is harmless for that one table).

5. **Smoke-test** sign-in (magic link and GitHub), device-code CLI login, and
   one OAuth flow against production immediately after.

6. Once confidence is high (a few days of clean operation), decommission the
   old `uploads-auth` and `uploads-auth-preview` D1 databases
   (`wrangler d1 delete`).

**Rollback.** If the deploy in step 3 misbehaves before step 4 completes,
revert `apps/auth/wrangler.jsonc`'s D1 binding back to the dedicated
`uploads-auth` database (`database_id: 24eb8b7f-5dff-46bc-a1a5-fa436810805d`,
`database_name: uploads-auth`, `migrations_dir: migrations` — restore
`apps/auth/migrations/` from git history) and redeploy; that database still
has every row it had before the move (the data-move script only ever reads
from it, never deletes). Any writes that land against the merged DB during
the time the worker was pointed at it are lost on rollback — this is the
same risk profile as any cutover, which is why the merge (step 3) and the
data move (step 4) need to happen back-to-back rather than with a gap. There
is no rollback path that recovers writes made against both databases during
a split-brain window.

### Auth worker: Secrets Store → plain secret cutover (uploads#754 item 2)

**Done.** `apps/auth`'s four auth secrets moved off the account-level
Cloudflare Secrets Store onto plain per-worker secrets in two steps: #756
added a dual-read accessor (plain preferred, store fallback) so the code
change was safe to merge before an operator ran `wrangler secret put`; once
the operator set all four plain values on the prod worker and confirmed
GitHub sign-in and sessions stayed healthy, a follow-up change removed the
`secrets_store_secrets` blocks from `apps/auth/wrangler.jsonc` (both the
top-level and `previews` blocks) and the store-fallback branches in
`apps/auth/src/secrets.ts`. `src/secrets.ts` now reads all four straight off
`env` like every other secret in this repo — no store, no fallback branch.

`apps/auth/wrangler.jsonc` also declares a `secrets` configuration property
now, covering all eight of the worker's secrets (the four above plus the
pre-existing plain Stripe/billing pair):

```jsonc
"secrets": {
  "required": [
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_API_KEY",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRO_PRICE_ID",
    "BILLING_INTERNAL_KEY",
  ],
}
```

This makes `wrangler deploy`/`wrangler versions upload` fail with a clear
error instead of shipping a 503-on-everything build if any of the eight are
missing from the target worker, and is now the source of truth `wrangler
types` reads for these names (see apps/auth's `src/env.d.ts`, which
deliberately keeps its own optional overrides for each — the app code treats
every one of them as fail-soft at runtime; `secrets.required` is a
deploy-time guarantee, not a type-level one).

**Rotating an independent secret** (`BETTER_AUTH_SECRET`, `BETTER_AUTH_API_KEY`,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID`,
`BILLING_INTERNAL_KEY`) is a plain `wrangler secret put <NAME>` from
`apps/auth` — no store, no binding, takes effect on the next request.

**Rotating `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` together** must NOT use
two separate `wrangler secret put` calls: each one deploys immediately, so a
sequential pair leaves a window where the new id is live against the old
secret (or vice versa) and GitHub OAuth briefly breaks. Update both in one
request instead:

```bash
printf 'GITHUB_CLIENT_ID=%s\nGITHUB_CLIENT_SECRET=%s\n' "$NEW_ID" "$NEW_SECRET" \
  | pnpm exec wrangler secret bulk
```

(from `apps/auth`; `wrangler secret bulk` also accepts a JSON file of
`{"key": "value"}` pairs). This lands both values in a single deploy, so
they're never mismatched.

**Previews.** This validates the same underlying `uploads-auth` Worker
script's secrets that production uses, not a separate `previews`-scoped set.
The automatic per-branch "Branch Preview URL" that Workers Builds deploys for
every PR runs against production bindings (see
[previews.md](previews.md#the-two-layers) — it is not the
`npx wrangler preview` / `previews` block flow), so it already sees the same
eight secrets and needed no changes here. A manual `wrangler preview`
inherits the same worker-level secrets too, unless a branch explicitly
overrides one with `wrangler preview secret put`.

## Minimal-binding profile (self-hosting, uploads#754 item 3)

The four workers' `wrangler.jsonc` files declare ~15+ bindings between them,
but not all of them are load-bearing. This section is the self-host contract:
which bindings a deployment must have to run at all, and which ones are
optional and degrade gracefully when skipped. **No dedicated self-hosting doc
exists yet in this repo** — this table lives here (the closest existing home
for operator-facing config) until one does; if that changes, move this
section wholesale rather than duplicating it.

Every optional binding below fails soft on its own: a self-hoster can delete
the corresponding block from `wrangler.jsonc` (or a preview/branch config)
without touching application code. This repo's own production config keeps
every binding — this table is about what tolerates absence, not what we
recommend removing.

### Core (required — absence is a hard crash or an unusable deploy)

| Binding                      | Worker(s)      | Type            |
| ---------------------------- | -------------- | --------------- |
| `DB`                         | api, auth, mcp | D1              |
| `REGISTRY`, `GITHUB_CACHE`   | api, mcp       | KV              |
| `UPLOADS`, `UPLOADS_DEFAULT` | api, mcp       | R2              |
| `AUTH`                       | api, web       | Service binding |
| `API`                        | auth, web      | Service binding |
| `ASSETS`                     | web            | Workers Assets  |

### Optional (fail-soft when absent)

| Binding                                                                        | Worker    | What's lost without it                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANALYTICS`                                                                    | api       | The `/admin/metrics` breakdown panel's wide-dimension data (surface, content type, client, plan, repo). D1-backed metrics still work.                                                                                                                                                                                                                                                                   |
| `ANALYTICS_API_TOKEN`                                                          | api       | Same as above — without it the breakdown panel reports `not_configured` even if `ANALYTICS` itself is bound.                                                                                                                                                                                                                                                                                            |
| `BROWSER`                                                                      | api       | `POST /v1/render` (CLI screenshot capture) answers 503 `renderer_unavailable`. Nothing else is affected.                                                                                                                                                                                                                                                                                                |
| `MEDIA`                                                                        | api       | Video poster-frame generation is skipped; uploads still succeed, just without a generated poster image.                                                                                                                                                                                                                                                                                                 |
| `FLAGS`                                                                        | api       | Every Flagship-gated feature evaluates to off (fails closed): poster generation, active-content uploads, and the attachment index shadow — same effect as never enabling them.                                                                                                                                                                                                                          |
| `GITHUB_WEBHOOK_QUEUE`                                                         | api       | GitHub webhook deliveries process inline (`waitUntil`) instead of through a durable queue — functionally the same, just without queue-level retry/DLQ semantics.                                                                                                                                                                                                                                        |
| `AUTH`                                                                         | mcp       | Uploader attribution on hosted-MCP uploads degrades to the id-only `gh.uploader-id` tag (no `gh.uploader` login) — the binding backs `uploaderTags()` in `@uploads/api/uploader-identity`, called from `apps/mcp/src/tools.ts`, and every failure path there fails soft. Uploads still succeed. (Listed here because a grep of `apps/mcp/src` alone misses the usage — it lives in the shared package.) |
| `WRITE_LIMITER`                                                                | api, mcp  | No per-workspace burst limit on uploads/deletes.                                                                                                                                                                                                                                                                                                                                                        |
| `RENDER_LIMITER`                                                               | api       | No burst limit on `POST /v1/render` independent of the monthly upload budget.                                                                                                                                                                                                                                                                                                                           |
| `WS_CREATE_LIMITER`                                                            | api       | No burst limit on self-serve workspace creation (the 3-per-user cap itself still applies).                                                                                                                                                                                                                                                                                                              |
| `INVITE_LIMITER`                                                               | api       | No per-recipient/IP rate limit on invite emails, invite lookup/exchange, or CLI report/abuse endpoints.                                                                                                                                                                                                                                                                                                 |
| `POSTER_LIMITER`                                                               | api       | **Fails closed, not open** — unlike every other limiter above, an absent `POSTER_LIMITER` disables poster generation entirely rather than removing its burst cap, since posters are a metered, billable operation.                                                                                                                                                                                      |
| `EMAIL`                                                                        | api       | Welcome emails, abuse-report notifications, and invite-code emails are skipped (logged instead); the underlying record/report/enrollment is still created.                                                                                                                                                                                                                                              |
| `EMAIL`                                                                        | auth      | Magic-link, invitation, member-joined, and welcome emails are skipped (logged instead, with the link itself logged for invitations). GitHub OAuth sign-in is unaffected — it has no dependency on `EMAIL`. A deployment with neither `EMAIL` nor GitHub OAuth configured has no working sign-in method; that's a configuration gap, not a crash.                                                        |
| `ADMIN_TOKEN`                                                                  | api       | The static break-glass admin token is disabled; scoped operator tokens (minted through the normal admin flow) still work.                                                                                                                                                                                                                                                                               |
| `BILLING_INTERNAL_KEY`                                                         | api, auth | Fails closed by design: `/internal/billing/plan` always 401s and the auth→api plan-sync bridge no-ops (queues a retry) instead of sending an unauthenticated request.                                                                                                                                                                                                                                   |
| `GITHUB_APP_WEBHOOK_SECRET`                                                    | api       | The GitHub webhook endpoint 503s.                                                                                                                                                                                                                                                                                                                                                                       |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_HOME_INSTALLATION_ID` | api, mcp  | GitHub App integration (PR/issue title resolution, managed comments, private-repo detection, auto-promotion) is disabled entirely — an all-or-nothing trio.                                                                                                                                                                                                                                             |
| `OPENAI_APPS_CHALLENGE`                                                        | mcp       | `/.well-known/openai-apps-challenge` 404s (only needed when submitting the OpenAI plugin directory listing).                                                                                                                                                                                                                                                                                            |

## Presign

`POST /v1/:ws/files/sign` — workspace needs HTTP S3 credentials (not binding-only).

## CLI observability (telemetry + reports)

Both live on the **existing** D1 binding (`uploads-production` / `DB`) — no new
database. One migration creates two tables
(`20260715120000_uploads_cli_observability.sql`):

| Table                      | Role                                                     |
| -------------------------- | -------------------------------------------------------- |
| `uploads_telemetry_events` | Automatic command-name pings (high volume, no free text) |
| `uploads_cli_reports`      | Explicit opt-in messages (+ optional log metadata)       |

**Why D1, not KV:** we need append + aggregate (`GROUP BY command`, recent
errors). KV is a key lookup store, not a query log. Report **blobs** use R2;
only metadata is in D1.

**Why two tables:** different volume, retention, and shape. Telemetry is
fire-and-forget counters; reports are sparse free text with optional
attachments. Sharing one polymorphic table would mostly add null columns.

### Telemetry (`POST /v1/telemetry`)

Command name, version, OS/arch, exit code, duration, allowlisted error code.
Opt-out: `UPLOADS_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, or
`uploads telemetry disable`. Kill switch: `TELEMETRY_DISABLED=1`.

### Reports (`POST /v1/reports`)

Explicit only (`uploads report` / MCP `report`). Message + optional text
attachment (max 256 KiB) at
`_internal/uploads-cli-reports/<rpt_id>/<file>` on `UPLOADS_DEFAULT`.
Rate limit: `INVITE_LIMITER` key `cli-report:<ip>`. Kill switch:
`REPORTS_DISABLED=1`.

```bash
wrangler d1 execute uploads-production --remote \
  --command "SELECT id, created_at, type, command, error_code, substr(message,1,80)
             FROM uploads_cli_reports ORDER BY created_at DESC LIMIT 20"

# Quote placeholders so shell redirection is not triggered by unquoted <…>.
REPORT_ID="rpt_…"
REPORT_FILE="trace.log"
wrangler r2 object get "uploads-default/_internal/uploads-cli-reports/${REPORT_ID}/${REPORT_FILE}" \
  --file ./trace.log
```

## Video poster thumbnails (issue #299)

Write-time poster generation (`generateAndStorePoster`,
`apps/api/src/files-core.ts`) runs on every `PUT /v1/:ws/files/:key` and
stores a `.jpg` frame at `_internal/posters/<key>.jpg`, flagging the source
object with D1 metadata `video.poster=1`. It does **not** run on
`POST /sign` uploads — those hand the client a presigned URL straight to R2,
bypassing the worker (and therefore `generateAndStorePoster`) entirely. Any
video uploaded that way needs a backfill pass (below) once generation is on.

### Kill switches (in order of blast radius)

1. **Flagship flag (preferred, instant, reversible)** — turn generation off
   globally without a deploy:

   ```bash
   wrangler flagship flags update 8371bfe7-9767-4b4d-b75a-37b94d2724f7 \
     video-poster-generation --default off
   ```

   Checked by `posterGenerationAllowed` (`apps/api/src/poster.ts`) on every
   write. Currently **off** in production — this feature has not shipped to
   users yet.

2. **Remove the `MEDIA` binding** — `generateAndStorePoster` needs
   `env.MEDIA` (Cloudflare Media Transformations) to extract a frame. Drop
   the binding from `wrangler.jsonc` and redeploy to hard-disable extraction
   regardless of the flag. Slower (needs a deploy) but survives a Flagship
   outage.

3. **`POSTER_LIMITER` denial (fails closed, no action needed)** — poster
   generation is gated behind its own rate limiter,
   `posterRateLimitGuard` / `POSTER_LIMITER` (`apps/api/src/guards.ts`). If
   that binding is ever absent from the environment, generation fails closed
   (treated as denied) rather than failing open — see
   `apps/api/src/poster.ts`'s comment on `posterGenerationAllowed`. This isn't
   something to toggle deliberately as a kill switch, but it means a
   misconfigured or missing `POSTER_LIMITER` binding is safe, not silently
   permissive.

Any of the three means: existing posters keep serving from
`_internal/posters/`, new writes just stop generating new ones — no data
loss, no user-visible error (the managed comment/file page renderer falls
back to its pre-#299 bullet link).

### Backfill script

`scripts/backfill-posters.mjs` finds `video/mp4` objects without a poster and
generates one for each, mirroring `apps/api/scripts/backfill-gh-metadata.mjs`
(same `--workspace`/`--dry-run` shape, same `UPLOADS_API_URL`/
`UPLOADS_WORKSPACE`/`UPLOADS_TOKEN` env vars, same cursor-walk-then-summarize
shape), plus `--limit <n>` to bound a run:

```bash
# Always dry-run first — read-only, prints the candidate plan, no writes.
node --env-file=.env scripts/backfill-posters.mjs --workspace default --dry-run --limit 20

# Real run once the plan looks sane.
node --env-file=.env scripts/backfill-posters.mjs --workspace default --limit 20
```

**Mechanism:** there is no admin route that calls `generateAndStorePoster`
directly for an already-stored object. The script instead re-`PUT`s each
candidate's existing bytes back to their own key
(`PUT /v1/:ws/files/:key`, no `X-Uploads-Meta-*` headers so existing D1
metadata is left untouched) — the same write path a fresh upload takes, which
already calls `generateAndStorePoster` after storing. **This means the
backfill only has an effect while the `video-poster-generation` flag is on**
(kill switch 1, above) — with it off, every re-put is a no-op write that
leaves the object exactly as it was.

**Idempotency:** a candidate that already carries `video.poster=1` is skipped
up front, so re-running the script is always safe. Objects over 10 minutes
are silently skipped server-side (`POSTER_MAX_DURATION_SECONDS`,
`apps/api/src/poster.ts`) and never get `video.poster` set — the script can't
know duration before the write path probes it, so those get reattempted (and
re-skipped) on every run. Harmless, just noisy in the summary line.

Filters applied before any write: `video.poster` already set (skip), content
type isn't `video/mp4` (skip), object over 100 MB (skip, matches
`POSTER_MAX_INPUT_BYTES`). Sleeps 3s between writes, comfortably under the
`POSTER_LIMITER` ceiling of 30/min.

**Visibility is preserved.** The re-PUT forwards `X-Uploads-Visibility:
private` whenever the listing marks the object private (the `visibility`
field `GET /v1/:ws/files` already returns per item); public objects send no
such header. Without this the backfill would silently make every private
video it touches public, since a PUT's R2 custom metadata is built fresh
each time (full-replace, not a merge) and the private flag is only set when
the request explicitly carries it.

**Cost — not free.** Each re-PUT is a real upload through the normal write
path, so every candidate consumes one unit of the workspace's
`maxUploadsPerPeriod` budget (`reserveUploads`), exactly like a brand-new
upload, even though no new object is created. There is no admin bypass for
this (would need a new endpoint; out of scope for this script). Before a
large run:

- Check the workspace's current upload budget/usage first.
- Use `--limit <n>` to bound how much budget a single run spends.
- Expect a large backfill to compete with real user uploads for the same
  budget, and to start failing with 429s if it exhausts it partway through.

## Attachment index shadow (issue #934)

The managed comment sync still renders from the R2 fan-out (one `ListObjects`
per prefix that can hold the target). Phase 1 (#938) writes every attachment
to the `github_attachments` D1 table; phase 2 reads that table alongside the
fan-out and logs the difference, so the index's coverage can be measured
before phase 3 switches the render to it.

**Flag:** Flagship `attachment-index-shadow`, same app as
`video-poster-generation`. Off by default; turning it on adds one D1 read per
comment sync, overlapped with the R2 listing, and never changes what renders.

```bash
wrangler flagship flags update 8371bfe7-9767-4b4d-b75a-37b94d2724f7 \
  attachment-index-shadow --default on
```

**Reading it:** one Workers Logs line per sync while the flag is on,
`component: "attachment-index"`, `event: "shadow"`. `match: true` means the
index and the post-detach fan-out agree. `missing` lists keys the fan-out
rendered that the index lacks (a write path the index misses, or an object
that predates #938 and needs the backfill); `extra` lists index rows the
fan-out did not render (a stale row: the object was deleted or moved without
the index hearing). Key lists are capped at five per side; `missingCount` /
`extraCount` are exact. Private prefix ids are redacted from the keys.

A `"attachment index: shadow read failed"` error line means the flag was on
but the D1 read (or the flag evaluation) threw; the sync still completed from
the fan-out.

Fails closed like the other flags: a missing `FLAGS` binding, a disabled
flag, or a thrown evaluation all mean no shadow.

## Deploys

Code via Workers Builds / `pnpm run deploy`. D1 migrations on merge. npm CLI via changesets.

See also [workspaces.md](workspaces.md), [deploy.md](deploy.md), [releasing.md](releasing.md).
