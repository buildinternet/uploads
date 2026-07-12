#!/usr/bin/env bash
#
# One-command local setup — the whole thing on autopilot, idempotently.
# Re-running is safe: every step skips what's already done and never overwrites
# your real env files or re-mints a workspace that already exists.
#
# Steps:
#   1. tooling     — Node ≥24 + corepack (pnpm is pinned via packageManager)
#   2. install     — pnpm install
#   3. env files   — scaffold .env / apps/api/.dev.vars from *.example (only if
#                    absent); mint ADMIN_TOKEN when still empty
#   4. types       — wrangler types → worker-configuration.d.ts (gitignored)
#   5. database    — apply local D1 migrations (enrollment, usage, galleries)
#   6. workspace   — seed the local `default` workspace in REGISTRY KV (once)
#   7. doctor      — verify the result
#
# Usage:
#   pnpm bootstrap                 # full setup
#   pnpm bootstrap --skip-db       # tooling + deps + env + types only
#   pnpm bootstrap --skip-workspace  # skip local workspace seed
#
# After it finishes:  pnpm dev   (API on :8787)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=lib-local.sh
. "$ROOT/scripts/lib-local.sh"

SKIP_DB=0
SKIP_WORKSPACE=0
for arg in "$@"; do
  case "$arg" in
    --skip-db) SKIP_DB=1 ;;
    --skip-workspace) SKIP_WORKSPACE=1 ;;
    -h | --help)
      sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown flag: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
add() { printf '  \033[33m+\033[0m %s\n' "$1"; }
note() { printf '  \033[36mi\033[0m %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

# Copy a committed template to its real path only if the real one is absent.
scaffold() {
  local example="$1" real="$2"
  if [ -f "$real" ]; then
    ok "$real already exists — left untouched"
  elif [ -f "$example" ]; then
    cp "$example" "$real"
    add "created $real from $(basename "$example")"
  else
    note "no template at $example — skipped"
  fi
}

# Append KEY=value to a file when KEY is missing or empty.
ensure_secret() {
  local file="$1" key="$2" value="$3" comment="$4"
  if [ ! -f "$file" ]; then
    return
  fi
  if grep -qE "^${key}=.+$" "$file" 2>/dev/null; then
    ok "$key already set in $(basename "$(dirname "$file")")/$(basename "$file")"
    return
  fi
  # Drop an empty KEY= line so we don't leave a duplicate.
  if grep -qE "^${key}=$" "$file" 2>/dev/null; then
    local tmp
    tmp="$(mktemp)"
    grep -vE "^${key}=$" "$file" >"$tmp" && mv "$tmp" "$file"
  fi
  {
    printf '\n# Added by scripts/bootstrap.sh — %s\n' "$comment"
    printf '%s=%s\n' "$key" "$value"
  } >>"$file"
  add "minted $key in $file"
}

echo "uploads — local setup"

# ── 1. tooling ───────────────────────────────────────────────────────────────
step "Tooling (Node, pnpm)"

if have node; then
  node_major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "$node_major" -ge 24 ]; then
    ok "node $(node -v) (≥24)"
  else
    note "node $(node -v) is below the required ≥24 — install Node 24+ (see .nvmrc)"
  fi
else
  note "node not found — install Node ≥24 (see .nvmrc: $(cat "$ROOT/.nvmrc" 2>/dev/null || echo 24.x))"
  note "Node is required; aborting the rest of setup until it's on PATH"
  exit 1
fi

if have corepack; then
  corepack enable >/dev/null 2>&1 && ok "corepack enabled (activates the pinned pnpm)" \
    || note "corepack present but 'corepack enable' needs sudo — run it yourself, then re-run bootstrap"
else
  note "corepack not found — install a recent Node (ships corepack) so pnpm is activated from packageManager"
fi

if have pnpm; then
  ok "pnpm $(pnpm -v)"
else
  note "pnpm not on PATH — try: corepack enable && corepack prepare --activate"
  note "pnpm is required; aborting"
  exit 1
fi

# ── 2. deps ──────────────────────────────────────────────────────────────────
step "Installing workspace dependencies"
pnpm install

# ── 3. env files ─────────────────────────────────────────────────────────────
step "Scaffolding env files (non-destructive)"
scaffold "$ROOT/.env.example" "$ROOT/.env"
scaffold "$ROOT/apps/api/.dev.vars.example" "$ROOT/apps/api/.dev.vars"

DEV_VARS="$ROOT/apps/api/.dev.vars"
if have openssl; then
  ensure_secret "$DEV_VARS" "ADMIN_TOKEN" "$(openssl rand -base64 32)" \
    "local admin gate for /admin/* (any non-empty string works)"
  # Optional encryption key for BYO S3 credentials in REGISTRY — harmless if unused.
  ensure_secret "$DEV_VARS" "WORKSPACE_SECRETS_KEY" "$(openssl rand -base64 32)" \
    "local encryption for BYO workspace secrets in REGISTRY KV"
else
  note "openssl not found — set ADMIN_TOKEN (and optionally WORKSPACE_SECRETS_KEY) in apps/api/.dev.vars by hand"
fi

# Point the root client .env at local wrangler if still on the prod defaults.
ENV_FILE="$ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  if grep -qE '^UPLOADS_API_URL=https://api\.uploads\.sh/?$' "$ENV_FILE" 2>/dev/null; then
    tmp="$(mktemp)"
    sed 's#^UPLOADS_API_URL=https://api\.uploads\.sh/?$#UPLOADS_API_URL=http://localhost:8787#' \
      "$ENV_FILE" >"$tmp" && mv "$tmp" "$ENV_FILE"
    add "pointed UPLOADS_API_URL at http://localhost:8787 in .env"
  elif grep -qE '^UPLOADS_API_URL=http://localhost:8787/?$' "$ENV_FILE" 2>/dev/null; then
    ok "UPLOADS_API_URL already points at local wrangler"
  else
    note "UPLOADS_API_URL is custom — left as-is (set to http://localhost:8787 for local API)"
  fi
fi

# ── 4. types ─────────────────────────────────────────────────────────────────
step "Generating wrangler types (worker-configuration.d.ts)"
if pnpm types; then
  ok "types generated for api / mcp / web"
else
  note "pnpm types failed — see output above; typecheck/lint may fail until it succeeds"
fi

# ── 5. local D1 ──────────────────────────────────────────────────────────────
if [ "$SKIP_DB" = 1 ]; then
  step "Skipping local D1 migrations (--skip-db)"
else
  step "Applying local D1 migrations"
  if pnpm --filter @uploads/api run migrate:d1:local; then
    ok "local D1 migrations applied"
  else
    note "D1 migrate failed — see output above; 'pnpm doctor' will detail what's missing"
  fi
fi

# ── 6. seed workspace ────────────────────────────────────────────────────────
if [ "$SKIP_WORKSPACE" = 1 ]; then
  step "Skipping local workspace seed (--skip-workspace)"
else
  step "Seeding local workspace (default)"
  # Prefer miniflare SQLite (instant, no wrangler process). Wrangler --local
  # boots miniflare and has been seen to hang/orphan when agents time out.
  already=0
  if local_registry_has_key "ws:default"; then
    already=1
  else
    rc=$?
    if [ "$rc" -eq 2 ]; then
      # sqlite3 missing — timed wrangler fallback (bounded so it cannot orphan).
      existing="$(local_registry_get_via_wrangler "ws:default" 20)"
      if [ -n "$existing" ] && [ "$existing" != "Value not found" ]; then
        already=1
      fi
    fi
  fi
  if [ "$already" -eq 1 ]; then
    ok "local workspace 'default' already registered — left as-is"
    note "need a fresh token?  pnpm workspace:add default --local  (prints a new bearer once)"
  else
    add "registering local workspace 'default'…"
    # Capture stdout so we can offer to write UPLOADS_TOKEN into .env.
    token_out=""
    if token_out="$(pnpm workspace:add default --local 2>&1)"; then
      printf '%s\n' "$token_out"
      ok "workspace 'default' registered in local REGISTRY KV"
      token="$(printf '%s\n' "$token_out" | sed -n 's/^token     : //p' | head -1)"
      if [ -n "$token" ] && [ -f "$ENV_FILE" ]; then
        if grep -qE '^UPLOADS_TOKEN=.+$' "$ENV_FILE" 2>/dev/null; then
          ok "UPLOADS_TOKEN already set in .env — left untouched (new token printed above)"
        else
          if grep -qE '^UPLOADS_TOKEN=$' "$ENV_FILE" 2>/dev/null; then
            tmp="$(mktemp)"
            # shellcheck disable=SC2016
            sed "s#^UPLOADS_TOKEN=\$#UPLOADS_TOKEN=${token}#" "$ENV_FILE" >"$tmp" && mv "$tmp" "$ENV_FILE"
          else
            printf '\n# Added by scripts/bootstrap.sh — local workspace bearer (default).\nUPLOADS_TOKEN=%s\n' \
              "$token" >>"$ENV_FILE"
          fi
          add "wrote UPLOADS_TOKEN into .env for local CLI use"
        fi
      else
        note "store the token printed above — only its hash is kept in KV"
      fi
    else
      printf '%s\n' "$token_out"
      note "workspace seed failed — see output above; re-run: pnpm workspace:add default --local"
    fi
  fi
fi

# ── 7. verify ────────────────────────────────────────────────────────────────
step "Verifying setup"
bash "$ROOT/scripts/doctor.sh" || true

cat <<'EOF'

Setup complete. Start the app:

  pnpm dev              # API worker on :8787 (local R2 + KV + D1)
  pnpm dev:web          # Astro site
  pnpm uploads put ./shot.png --env-file .env   # monorepo CLI against local API

Run `pnpm check` and `pnpm typecheck` before opening a PR.
If something looks off later: `pnpm doctor`

EOF
