#!/usr/bin/env bash
# Run the uploads plugin eval suite.
#
# WHY THIS SCRIPT EXISTS: `claude plugin eval .` fails at the repo root with
#   E2BIG: argument list too long, posix_spawn
# because this repo is huge (~6.4G of .claude/worktrees plus node_modules) and
# the runner enumerates the plugin directory. Identical plugin files in a small
# directory work fine. So we sync just the plugin + this suite into a temp dir
# and run there. Results are copied back to evals/results/.
#
# Usage:
#   ./run.sh                      # full suite, both arms (the real thing)
#   ./run.sh --case '01*' --ablation none --runs 1    # cheap single-case debug
#
# Everything after the script name is passed through to `claude plugin eval`.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/uploads-eval-$$"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK"

# The Bash sandbox refuses to run when the Docker credential store holds
# symlinks inside it (~/.docker/cli-plugins is full of Docker Desktop's own
# links). Point DOCKER_CONFIG at a minimal plain copy for this run only; the
# real ~/.docker is never touched.
DOCKER_SHIM="$WORK/docker-config"
mkdir -p "$DOCKER_SHIM"
for f in config.json contexts; do
  [ -e "$HOME/.docker/$f" ] && cp -R "$HOME/.docker/$f" "$DOCKER_SHIM/" 2>/dev/null || true
done
find "$DOCKER_SHIM" -type l -delete 2>/dev/null || true
export DOCKER_CONFIG="$DOCKER_SHIM"
cp -R "$REPO/.claude-plugin" "$REPO/skills" "$REPO/.mcp.json" "$REPO/hooks" "$WORK"/
[ -d "$REPO/assets" ] && cp -R "$REPO/assets" "$WORK"/
mkdir -p "$WORK/evals"
# suite files only — never copy results in
for p in "$REPO"/evals/*; do
  base="$(basename "$p")"
  [ "$base" = "results" ] && continue
  cp -R "$p" "$WORK/evals/$base"
done
rm -rf "$WORK/evals/results"

cd "$WORK"
set +e
claude plugin eval . \
  --scaffold \
  --trust-plugin \
  --no-publish \
  --model sonnet \
  --judge-model sonnet \
  --allow-tools Write Edit \
  "$@"
STATUS=$?
set -e

# copy results back into the real repo
if [ -d "$WORK/evals/results" ]; then
  mkdir -p "$REPO/evals/results"
  cp -R "$WORK/evals/results/." "$REPO/evals/results/"
  echo "Results copied to $REPO/evals/results/"
fi
exit $STATUS
