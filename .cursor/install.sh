#!/usr/bin/env bash
#
# Cloud Agent install — prepare the uploads monorepo for development.
#
# Runs from the repository root after Cursor checks out the revision. It is
# idempotent: re-running skips work that is already done and never overwrites a
# real .env / .dev.vars or re-mints an existing local workspace. Keep long-
# running servers out of here — they belong in `terminals` (see environment.json).
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

# ── Node (pinned by .nvmrc) via nvm ──────────────────────────────────────────
# The default Cloud Agent image ships nvm; install it if a custom base lacks it.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "nvm not found at $NVM_DIR — installing it"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

NODE_VERSION="$(tr -d '[:space:]' <"$ROOT/.nvmrc")"
nvm install "$NODE_VERSION"
nvm alias default "$NODE_VERSION"
nvm use default

# ── pnpm (pinned by package.json "packageManager") ───────────────────────────
corepack enable
corepack prepare pnpm@11.10.0 --activate

# ── deps, env scaffolding, wrangler types, local D1, default workspace ───────
# `pnpm bootstrap` runs pnpm install and the rest of the local setup, then a
# read-only doctor check. See scripts/bootstrap.sh.
pnpm bootstrap
