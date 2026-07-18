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

The API worker also runs a **daily cron** (`0 6 * * *` UTC) that purges every workspace with `retentionDays` set. Logs: `retention_sweep` JSON.

The same sweep also finalizes soft-deleted workspaces (see below): once a
workspace's grace window elapses, the sweep runs the full hard teardown and
replaces its `ws:<name>` KV record with a permanent purged tombstone. That
work is logged separately per workspace as `workspace_purged` and rolled up
into the sweep's `workspacesFinalized` field.

## Workspace deletion, restore, and finalization

`DELETE /admin/workspaces/:name` is **soft by default** (#247): it stamps
`deletedAt`/`purgeAt` (14-day grace window, `WORKSPACE_DELETE_GRACE_DAYS`) on
the KV record and puts it back. Access denies immediately — every
auth/serving path treats a `deletedAt` record as not found — but R2 objects,
file metadata, and galleries are untouched. Deleting an already-soft-deleted
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
tombstone under `ws:<name>` so the name can never be re-registered. The
communal/protected-workspace guard applies to both modes.

See [docs/deletion.md](deletion.md) for the full cross-surface deletion
policy and rationale.

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

## Invitations

### Workspace admins (normal path)

People with org role **admin** or **owner** on a workspace invite teammates
without `ADMIN_TOKEN` or a global site-admin role:

- **Web:** `/account/workspaces/<name>/invite` → “Invite a teammate” (session
  cookie → `POST /me/workspaces/:name/invites`)
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
the only workspace overwritten by the stack; `default` stays communal and is never
used for browser enumeration. Fixture object previews intentionally remain out of
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

## Deploys

Code via Workers Builds / `pnpm run deploy`. D1 migrations on merge. npm CLI via changesets.

See also [workspaces.md](workspaces.md), [deploy.md](deploy.md), [releasing.md](releasing.md).
