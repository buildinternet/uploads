#!/usr/bin/env bash
#
# Diagnose the local dev setup — the read-only inverse of bootstrap.sh.
#
# Scans installed tooling, local D1 / REGISTRY KV, and env files, then reports
# what's present, what's missing, and how to fix each gap. Never installs or
# mutates anything. Exits non-zero if a REQUIRED check fails (usable as a
# pre-flight gate).
#
#   pnpm doctor           # report
#   pnpm doctor --strict  # treat warnings as failures too
set -uo pipefail

STRICT=0
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=1 ;;
    -h | --help)
      sed -n '3,11p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown flag: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib-local.sh
. "$ROOT/scripts/lib-local.sh"
ERRORS=0
WARNS=0

c_green=$'\033[32m'
c_yellow=$'\033[33m'
c_red=$'\033[31m'
c_cyan=$'\033[36m'
c_dim=$'\033[2m'
c_off=$'\033[0m'

pass() { printf '  %s✓%s %s\n' "$c_green" "$c_off" "$1"; }
info() { printf '  %si%s %s\n' "$c_cyan" "$c_off" "$1"; }
# warn <label> <fix>
warn() {
  WARNS=$((WARNS + 1))
  printf '  %s⚠%s %s\n' "$c_yellow" "$c_off" "$1"
  [ -n "${2:-}" ] && printf '      %s→ %s%s\n' "$c_dim" "$2" "$c_off"
}
# fail <label> <fix>
fail() {
  ERRORS=$((ERRORS + 1))
  printf '  %s✗%s %s\n' "$c_red" "$c_off" "$1"
  [ -n "${2:-}" ] && printf '      %s→ %s%s\n' "$c_dim" "$2" "$c_off"
}
have() { command -v "$1" >/dev/null 2>&1; }
section() { printf '\n%s\n' "$1"; }

echo "uploads — environment doctor"

# ── Runtime ──────────────────────────────────────────────────────────────────
section "Runtime"
if have node; then
  node_major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "$node_major" -ge 24 ]; then
    pass "node $(node -v) (≥24)"
  else
    fail "node $(node -v) is below the required ≥24" \
      "install Node 24+ (see .nvmrc: $(cat "$ROOT/.nvmrc" 2>/dev/null || echo 24.x))"
  fi
  if [ -f "$ROOT/.nvmrc" ] && [ "$(node -v | sed 's/^v//')" != "$(cat "$ROOT/.nvmrc")" ]; then
    info "node $(node -v) differs from pinned .nvmrc ($(cat "$ROOT/.nvmrc")) — fine if major matches"
  fi
else
  fail "node not found" "install Node ≥24, then 'corepack enable'"
fi

if have pnpm; then
  pnpm_major="$(pnpm -v | sed 's/\..*//')"
  if [ "$pnpm_major" -ge 11 ]; then
    pass "pnpm $(pnpm -v) (≥11)"
  else
    fail "pnpm $(pnpm -v) is below the required ≥11" \
      "corepack enable && corepack prepare --activate"
  fi
else
  fail "pnpm not found" "corepack enable (pnpm is pinned via packageManager)"
fi

if [ -d "$ROOT/node_modules" ]; then
  pass "dependencies installed (node_modules present)"
else
  fail "dependencies not installed" "pnpm install  (or: pnpm bootstrap)"
fi

# ── Generated types ──────────────────────────────────────────────────────────
section "Generated types"
# worker-configuration.d.ts is gitignored; CI / pre-commit run `pnpm types` first.
for app in api mcp web auth; do
  types_file="$ROOT/apps/$app/worker-configuration.d.ts"
  if [ -f "$types_file" ]; then
    pass "apps/$app/worker-configuration.d.ts present"
  else
    warn "apps/$app/worker-configuration.d.ts missing — type-aware lint/typecheck need it" \
      "pnpm types  (or: pnpm bootstrap)"
  fi
done

# ── Local D1 ─────────────────────────────────────────────────────────────────
section "Local D1 database"
D1_STATE="$ROOT/apps/api/.wrangler/state/v3/d1"
if [ -d "$D1_STATE" ]; then
  pass "local D1 state present (apps/api/.wrangler/state/v3/d1)"
else
  warn "local D1 not built yet — enrollment / usage / gallery routes need migrations" \
    "pnpm --filter @uploads/api run migrate:d1:local  (or: pnpm bootstrap)"
fi

AUTH_D1_STATE="$ROOT/apps/auth/.wrangler/state/v3/d1"
if [ -d "$AUTH_D1_STATE" ]; then
  pass "local Auth D1 state present (apps/auth/.wrangler/state/v3/d1)"
else
  warn "local Auth D1 not built yet — authenticated local stack needs migrations" \
    "pnpm --filter @uploads/auth run migrate:d1:local  (or: pnpm bootstrap)"
fi

# Best-effort pending-migration checks. Always time-bound: unbounded
# wrangler --local has orphaned multi-GB processes.
check_local_migrations() {
  local app="$1"
  local label="$2"
  local mig_out
  mig_out="$(
    run_with_timeout 30 pnpm --filter "@uploads/$app" exec wrangler d1 migrations list DB --local 2>/dev/null || true
  )"
  if printf '%s\n' "$mig_out" | grep -qiE 'No migrations.*(to apply|pending|waiting)'; then
    pass "no pending local ${label}D1 migrations"
  elif printf '%s\n' "$mig_out" | grep -qE 'Migrations to be applied|┌─'; then
    warn "local ${label}D1 has pending migrations" \
      "pnpm --filter @uploads/$app run migrate:d1:local"
  else
    info "could not parse local ${label}D1 migration status — skip if migrate:d1:local already ran"
  fi
}

if [ -d "$ROOT/apps/api/node_modules/wrangler" ] || [ -d "$ROOT/node_modules/wrangler" ]; then
  check_local_migrations api ""
  check_local_migrations auth "Auth "
fi

# ── Local workspace registry ─────────────────────────────────────────────────
section "Local workspace (REGISTRY KV)"
# Prefer miniflare SQLite over `wrangler kv key get --local` (see scripts/lib-local.sh).
if local_registry_has_key "ws:default"; then
  pass "local workspace 'default' registered in REGISTRY KV"
else
  rc=$?
  if [ "$rc" -eq 2 ] && { [ -d "$ROOT/apps/api/node_modules/wrangler" ] || [ -d "$ROOT/node_modules/wrangler" ]; }; then
    ws_out="$(local_registry_get_via_wrangler "ws:default" 20)"
    if [ -n "$ws_out" ] && [ "$ws_out" != "Value not found" ] && printf '%s' "$ws_out" | grep -q '{'; then
      pass "local workspace 'default' registered in REGISTRY KV"
    else
      warn "local workspace 'default' not found — authenticated routes return 401" \
        "pnpm workspace:add default --local  (or: pnpm bootstrap)"
    fi
  elif [ -d "$ROOT/apps/api/.wrangler/state/v3/kv" ] || [ -d "$ROOT/apps/api/node_modules/wrangler" ] || [ -d "$ROOT/node_modules/wrangler" ]; then
    warn "local workspace 'default' not found — authenticated routes return 401" \
      "pnpm workspace:add default --local  (or: pnpm bootstrap)"
  else
    info "local REGISTRY state not built yet — skip after 'pnpm bootstrap' / workspace:add --local"
  fi
fi

# ── Env files ────────────────────────────────────────────────────────────────
section "Env files"
API_DEV_VARS="$ROOT/apps/api/.dev.vars"
if [ -f "$API_DEV_VARS" ]; then
  pass "apps/api/.dev.vars present"
  if grep -qE '^ADMIN_TOKEN=.+$' "$API_DEV_VARS"; then
    pass "ADMIN_TOKEN is set (gates /admin/* locally)"
  else
    warn "ADMIN_TOKEN is empty — local /admin/* rejects every request" \
      "set any non-empty string in apps/api/.dev.vars  (or: pnpm bootstrap)"
  fi
  if grep -qE '^WORKSPACE_SECRETS_KEY=.+$' "$API_DEV_VARS"; then
    pass "WORKSPACE_SECRETS_KEY is set (BYO secret encryption)"
  else
    info "WORKSPACE_SECRETS_KEY unset — only needed for encrypted BYO S3 credentials"
  fi
else
  warn "apps/api/.dev.vars missing — wrangler will not load local secrets" \
    "cp apps/api/.dev.vars.example apps/api/.dev.vars  (or: pnpm bootstrap)"
fi

AUTH_DEV_VARS="$ROOT/apps/auth/.dev.vars"
if [ -f "$AUTH_DEV_VARS" ]; then
  pass "apps/auth/.dev.vars present"
  if grep -qE '^BETTER_AUTH_SECRET_DEV=.+$' "$AUTH_DEV_VARS"; then
    pass "BETTER_AUTH_SECRET_DEV is set (local Auth can issue stable sessions)"
  else
    warn "BETTER_AUTH_SECRET_DEV is empty — local Auth returns 503" \
      "set a random 32+ character value in apps/auth/.dev.vars  (or: pnpm bootstrap)"
  fi
  if grep -qE '^ENVIRONMENT=development$' "$AUTH_DEV_VARS"; then
    pass "Auth ENVIRONMENT is development"
  else
    warn "Auth ENVIRONMENT is not development — local demo session stays disabled" \
      "set ENVIRONMENT=development in apps/auth/.dev.vars"
  fi
else
  warn "apps/auth/.dev.vars missing — local Auth cannot sign sessions" \
    "cp apps/auth/.dev.vars.example apps/auth/.dev.vars  (or: pnpm bootstrap)"
fi

if [ -f "$ROOT/.env" ]; then
  pass "root .env present (CLI + optional deploy credentials)"
  if grep -qE '^UPLOADS_API_URL=http://127\.0\.0\.1:8787/?$' "$ROOT/.env"; then
    pass "UPLOADS_API_URL points at local wrangler (:8787)"
  elif grep -qE '^UPLOADS_API_URL=http://localhost:8787/?$' "$ROOT/.env"; then
    warn "UPLOADS_API_URL uses localhost; the authenticated stack uses 127.0.0.1 for cookies" \
      "set UPLOADS_API_URL=http://127.0.0.1:8787 (or re-run pnpm bootstrap)"
  elif grep -qE '^UPLOADS_API_URL=.+$' "$ROOT/.env"; then
    info "UPLOADS_API_URL is not local — fine for talking to prod; use http://127.0.0.1:8787 for local API"
  else
    warn "UPLOADS_API_URL unset in .env" "set UPLOADS_API_URL=http://127.0.0.1:8787 for local CLI"
  fi
  if grep -qE '^UPLOADS_TOKEN=.+$' "$ROOT/.env"; then
    pass "UPLOADS_TOKEN is set (CLI can authenticate)"
  else
    warn "UPLOADS_TOKEN empty — 'pnpm uploads put' / curl need a workspace bearer" \
      "pnpm workspace:add default --local  (prints token once) then paste into .env"
  fi
else
  info "root .env absent — optional for pure API work; needed for monorepo CLI + headless deploy"
fi

# ── Optional deploy credentials ──────────────────────────────────────────────
section "Deploy credentials (optional)"
env_has() { [ -f "$ROOT/.env" ] && grep -qE "^$1=.+" "$ROOT/.env" 2>/dev/null; }
for key in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN; do
  if [ -n "${!key:-}" ] || env_has "$key"; then
    pass "$key set"
  else
    info "$key not set — only needed for 'pnpm deploy' / remote D1 without 'wrangler login'"
  fi
done
for key in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  if [ -n "${!key:-}" ] || env_has "$key"; then
    pass "$key set"
  else
    info "$key not set — only needed for HTTP-mode / real-bucket dev workspaces"
  fi
done

# ── Summary ──────────────────────────────────────────────────────────────────
section "Summary"
if [ "$ERRORS" -gt 0 ]; then
  printf '  %s%s error(s)%s, %s warning(s) — fix the ✗ items above\n' "$c_red" "$ERRORS" "$c_off" "$WARNS"
  exit 1
elif [ "$WARNS" -gt 0 ]; then
  printf '  0 errors, %s%s warning(s)%s\n' "$c_yellow" "$WARNS" "$c_off"
  [ "$STRICT" = 1 ] && exit 1
  exit 0
else
  printf '  %sall checks passed%s — run `pnpm check` before opening a PR\n' "$c_green" "$c_off"
  exit 0
fi
