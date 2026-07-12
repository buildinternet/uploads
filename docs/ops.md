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

## Ledger + retention

```bash
uploads usage
uploads reconcile          # storage is truth
uploads purge-expired      # needs retentionDays
```

The API worker also runs a **daily cron** (`0 6 * * *` UTC) that purges every workspace with `retentionDays` set. Logs: `retention_sweep` JSON.

## Invitations

Invitation creation is an operator-only action behind `ADMIN_TOKEN`. Keep that secret
in the operator environment; never place it in agent configuration, prompts, issues,
or commands shared with adopters. Create an invitation for an existing workspace with:

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
# or, if you must call wrangler by hand:
timeout 20s pnpm --filter @uploads/api exec wrangler kv key get ws:default \
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

| Secret                           | Purpose                                                               |
| -------------------------------- | --------------------------------------------------------------------- |
| `ADMIN_TOKEN`                    | `/admin/*`                                                            |
| `WORKSPACE_SECRETS_KEY`          | **Current** KEK for BYO credentials in KV (`enc:v1:…`)                |
| `WORKSPACE_SECRETS_KEY_PREVIOUS` | **Previous** KEK during rotation only (decrypt fallback, then remove) |

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

## Deploys

Code via Workers Builds / `pnpm run deploy`. D1 migrations on merge. npm CLI via changesets.

See also [workspaces.md](workspaces.md), [deploy.md](deploy.md), [releasing.md](releasing.md).
