# Operator runbook

Day-to-day ops for **uploads.sh**. Secrets stay out of git.

## Workspace limits

```bash
pnpm workspace:limits <name>
pnpm workspace:limits <name> \
  --max-storage 25GB \
  --max-uploads-per-month 10000 \
  --max-upload-bytes 25MB \
  --max-video-bytes 8MB \
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
know. `uploads login --code` honors codes issued this way, and the `/console`
scaffold (behind the console-mode flag) uses it internally.

```bash
ADMIN_TOKEN=<admin-credential> uploads admin invite create \
  --workspace default --label early-adopter
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

`wrangler … --local` starts miniflare against `apps/api/.wrangler/state`. That is
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

| Secret                           | Purpose                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `ADMIN_TOKEN`                    | `/admin/*` — break-glass ops/CI use, not routine admin work (see [admin-tokens](admin-tokens.md)) |
| `WORKSPACE_SECRETS_KEY`          | **Current** KEK for BYO credentials in KV (`enc:v1:…`)                                            |
| `WORKSPACE_SECRETS_KEY_PREVIOUS` | **Previous** KEK during rotation only (decrypt fallback, then remove)                             |

```bash
# Generate
openssl rand -base64 32

# First-time install (production, from apps/api)
pnpm exec wrangler secret put WORKSPACE_SECRETS_KEY
```

`workspace:add --bucket …` encrypts keys when `WORKSPACE_SECRETS_KEY` is in the env. Plaintext legacy values still work until re-written. Decrypt tries **current**, then **previous**, so rotation does not brick BYO workspaces mid-cutover.

### Rotating `WORKSPACE_SECRETS_KEY`

**Putting secrets** is always `wrangler secret put` (the Worker config).
**Re-sealing records** is an **admin API** so the KEK stays on the worker (not in shell history).

1. Generate a new key: `openssl rand -base64 32` → keep OLD and NEW.
2. Install both on the worker (from `apps/api`):
   ```bash
   pnpm exec wrangler secret put WORKSPACE_SECRETS_KEY_PREVIOUS   # paste OLD
   pnpm exec wrangler secret put WORKSPACE_SECRETS_KEY            # paste NEW
   ```
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
4. Verify BYO / presign. Logs may show `credential_decrypted_with_previous_key`
   until re-seal finishes.
5. Drop the previous secret:
   ```bash
   pnpm exec wrangler secret delete WORKSPACE_SECRETS_KEY_PREVIOUS
   ```

Do **not** delete PREVIOUS before re-encrypt completes.

## Presign

`POST /v1/:ws/files/sign` — workspace needs HTTP S3 credentials (not binding-only).

## Console visibility

Console visibility controls links, not security — the console is bearer-token authenticated, so anyone with a valid workspace token can use it regardless of this setting. Three modes: `"public"` links to it from `/account`; `"linked-only"` (default) keeps the route serving but drops those links, so people find it deliberately; `"off"` makes `/console` 404.

Resolution order (see apps/web `src/lib/console-mode.ts`): the Flagship `console-mode` flag (app "uploads", `FLAGS` binding) wins when present, so prod can flip modes without a redeploy — `wrangler flagship flags update <app-id> console-mode --default <mode>`. The `CONSOLE_MODE` var in apps/web `wrangler.jsonc` is the fallback. Self-hosters without Flagship: delete the `flagship` block from wrangler.jsonc and set the var.

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

## Deploys

Code via Workers Builds / `pnpm run deploy`. D1 migrations on merge. npm CLI via changesets.

See also [workspaces.md](workspaces.md), [deploy.md](deploy.md), [releasing.md](releasing.md).
