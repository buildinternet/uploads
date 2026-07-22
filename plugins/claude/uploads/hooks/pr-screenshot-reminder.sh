#!/bin/sh
# PreToolUse hook (matcher: Bash) for the uploads plugin.
#
# When an agent is about to run `gh pr create` and the branch diff touches
# visually-observable files (UI markup/styles or anything under an /email/
# path) but no screenshots are staged on uploads.sh for this branch, emit a
# non-blocking advisory reminder. Never blocks PR creation: any failure,
# timeout, or missing tool causes a silent exit 0.
#
# Disable this hook by setting UPLOADS_HOOK_DISABLE=1 in your environment,
# or by removing the hooks entry from plugins/claude/uploads/hooks/hooks.json.
#
# Testability: set UPLOADS_HOOK_TEST_FILES to a newline-separated list of
# changed file paths to bypass the real git diff (used by manual tests).

set -eu

# Fail open on any unexpected error from this point on.
trap 'exit 0' EXIT

if [ "${UPLOADS_HOOK_DISABLE:-}" = "1" ]; then
  exit 0
fi

input="$(cat)"

# Extract the Bash command from the PreToolUse tool_input JSON.
command="$(printf '%s' "$input" | node -e '
  let data = "";
  process.stdin.on("data", d => data += d);
  process.stdin.on("end", () => {
    try {
      const j = JSON.parse(data);
      process.stdout.write(String((j.tool_input && j.tool_input.command) || ""));
    } catch (e) {
      process.stdout.write("");
    }
  });
' 2>/dev/null || true)"

if [ -z "$command" ]; then
  exit 0
fi

# Word-boundary-ish match for `gh pr create`, tolerant of flags/prefixes
# (e.g. `cd foo && gh pr create ...`, `GH_TOKEN=x gh pr create ...`).
case "$command" in
  *"gh pr create"*) : ;;
  *) exit 0 ;;
esac

# Must be inside a git repo to compute a diff.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [ -z "$branch" ] || [ "$branch" = "HEAD" ]; then
  exit 0
fi

# Determine the default branch to diff against: prefer origin's HEAD, fall
# back to main.
default_branch="$(git remote show origin 2>/dev/null | sed -n 's/.*HEAD branch: //p' | head -n1 || true)"
if [ -z "$default_branch" ]; then
  default_branch="main"
fi

merge_base="$(git merge-base "origin/${default_branch}" HEAD 2>/dev/null || git merge-base "${default_branch}" HEAD 2>/dev/null || true)"

if [ -n "${UPLOADS_HOOK_TEST_FILES:-}" ]; then
  changed_files="$UPLOADS_HOOK_TEST_FILES"
elif [ -n "$merge_base" ]; then
  changed_files="$(git diff --name-only "$merge_base" HEAD 2>/dev/null || true)"
else
  changed_files="$(git diff --name-only HEAD 2>/dev/null || true)"
fi

if [ -z "$changed_files" ]; then
  exit 0
fi

is_visual=0
old_ifs="$IFS"
IFS='
'
for f in $changed_files; do
  case "$f" in
    *.astro|*.tsx|*.jsx|*.vue|*.svelte|*.html|*.css|*.scss|*.less)
      is_visual=1
      ;;
    */email/*)
      is_visual=1
      ;;
  esac
  [ "$is_visual" = "1" ] && break
done
IFS="$old_ifs"

if [ "$is_visual" != "1" ]; then
  exit 0
fi

# Check whether the CLI is installed at all; fail open if not.
if ! command -v uploads >/dev/null 2>&1; then
  exit 0
fi

branch_lower="$(printf '%s' "$branch" | tr '[:upper:]' '[:lower:]')"

# `timeout` is GNU coreutils and absent on stock macOS; fall back to running
# bare (the hook-level timeout in hooks.json still bounds us).
if command -v timeout >/dev/null 2>&1; then
  run_find() { timeout 5 uploads find "gh.branch=${branch_lower}" --format json 2>/dev/null; }
else
  run_find() { uploads find "gh.branch=${branch_lower}" --format json 2>/dev/null; }
fi

if ! find_output="$(run_find)"; then
  # Timed out, errored, or uploads isn't configured/logged in — fail open.
  exit 0
fi
# NOTE: zero matches yields empty stdout with exit 0 — that is the "nothing
# staged" signal, so it must NOT fail open here.

staged_count="$(printf '%s' "$find_output" | node -e '
  let data = "";
  process.stdin.on("data", d => data += d);
  process.stdin.on("end", () => {
    try {
      const j = JSON.parse(data);
      const arr = Array.isArray(j) ? j : (j.items || j.results || j.files || []);
      process.stdout.write(String(Array.isArray(arr) ? arr.length : 0));
    } catch (e) {
      process.stdout.write("0");
    }
  });
' 2>/dev/null || echo 0)"

if [ "$staged_count" != "0" ]; then
  exit 0
fi

fork_note=""
is_fork="$(timeout 3 gh repo view --json isFork -q .isFork 2>/dev/null || true)"
if [ "$is_fork" = "true" ]; then
  fork_note=" Note: this looks like a fork branch, so staged screenshots won't auto-promote into the PR comment yet (see issue #317) — attach them manually if you use uploads."
fi

message="This PR touches UI files (astro/tsx/jsx/vue/svelte/html/css/scss/less or an /email/ path) but no screenshots are staged for branch '${branch}' on uploads.sh. Consider running \`uploads attach <shot.png> --branch --state after\` (and a --state before if useful) before or after opening the PR — the managed attachments comment assembles from staged files automatically.${fork_note}"

# Remove the fail-open trap now that we're emitting a deliberate result.
trap - EXIT

# Advisory only: no permissionDecision (that would bypass the user's normal
# permission prompt for the gh command). additionalContext reaches the model;
# systemMessage is shown to the user.
node -e '
  const msg = process.argv[1];
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: msg
    },
    systemMessage: msg
  }));
' "$message"

exit 0
