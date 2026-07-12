# Shared helpers for bootstrap/doctor — keep local checks cheap and bounded.
# Sourced by other scripts; not executable on its own.
#
# Why this exists: `wrangler kv key get … --local` boots miniflare and has been
# observed to orphan + balloon to multi-GB when the parent shell/agent dies or
# the process hangs in an error path. Prefer reading miniflare's on-disk SQLite
# for existence checks; when wrangler must run, always wrap it with a timeout.

# run_with_timeout SECONDS CMD [ARGS…]
# Prefer GNU coreutils `timeout` / `gtimeout`; fall back to perl alarm.
run_with_timeout() {
  local secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout --kill-after=5s "${secs}s" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout --kill-after=5s "${secs}s" "$@"
  else
    perl -e 'alarm shift; exec @ARGV' "$secs" "$@"
  fi
}

# local_registry_has_key KEY
# True if miniflare local REGISTRY KV has KEY (e.g. ws:default).
# Exit 0 = present, 1 = absent / no state, 2 = sqlite3 missing (caller may
# fall back to a timed wrangler get).
# Expects ROOT to point at the monorepo root.
local_registry_has_key() {
  local key="$1"
  local dir="${ROOT}/apps/api/.wrangler/state/v3/kv/miniflare-KVNamespaceObject"
  local db
  if [ ! -d "$dir" ]; then
    return 1
  fi
  if ! command -v sqlite3 >/dev/null 2>&1; then
    return 2
  fi
  # key is a fixed workspace id from our scripts — quote for SQL safety anyway.
  local qkey
  qkey=$(printf "%s" "$key" | sed "s/'/''/g")
  for db in "$dir"/*.sqlite; do
    [ -f "$db" ] || continue
    case "$(basename "$db")" in
      metadata.sqlite) continue ;;
    esac
    if [ "$(sqlite3 "$db" "SELECT 1 FROM _mf_entries WHERE key = '${qkey}' LIMIT 1;" 2>/dev/null)" = "1" ]; then
      return 0
    fi
  done
  return 1
}

# local_registry_get_via_wrangler KEY
# Timed wrangler fallback when SQLite is unavailable. Caps wall time so agent
# timeouts cannot leave a multi-GB orphan behind.
local_registry_get_via_wrangler() {
  local key="$1"
  local secs="${2:-20}"
  run_with_timeout "$secs" \
    pnpm --filter @uploads/api exec wrangler kv key get "$key" \
    --binding REGISTRY --local 2>/dev/null || true
}
