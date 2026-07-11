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

Suggested **shared/agent** defaults: 25 GB storage, 10k uploads/month, 25 MB images, 8 MB video, 90-day retention, key prefixes `default` (`f/`, `screenshots/`, `gh/`), max depth 8. **Throwaway**: 1 GB / 1k / 15 MB / 5 MB video / 90 days / same key policy.

**New workspaces** (`pnpm workspace:add`) apply the shared/agent template
automatically (source: `apps/api/scripts/workspace-limit-defaults.mjs`). Pass
`--no-default-limits` to start unlimited, or override individual fields with the
usual `--max-*` flags (`unlimited` clears one field). Existing workspaces are
unchanged until you run `workspace:limits`.

`--allowed-prefixes default` expands to the typed destinations agents already use. Clear with `--clear-allowed-prefixes` / `--clear-max-key-depth`. Puts outside the allowlist return **400** `key_prefix_not_allowed`; too-deep paths return **400** `key_too_deep`.

KV cache ~60s. Agents: `uploads usage`.

## Ledger + retention

```bash
uploads usage
uploads reconcile          # storage is truth
uploads purge-expired      # needs retentionDays
```

The API worker also runs a **daily cron** (`0 6 * * *` UTC) that purges every workspace with `retentionDays` set. Logs: `retention_sweep` JSON.

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
