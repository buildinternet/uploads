# Multi-harness hooks for uploads

**Status:** implemented (lean) on branch `docs/multi-harness-hooks`  
**Date:** 2026-07-24  
**Scope:** take the PR screenshot reminder (today Claude-plugin-only) to Grok, Codex, Cursor, and any future harness that speaks a compatible hook protocol.

**Shipped shape (kept small):**

- One runtime: `uploads hook pre-pr-screenshot`
- One shared manifest: `hooks/hooks.json` (Claude marketplace + Codex plugin)
- **`uploads install hooks`** only for Grok + Cursor (user-global) — not Codex,
  so the plugin and install never double-fire
- No Copilot adapter, no harness framework

## Problem

**Before this work** the PR screenshot reminder lived only under the Claude
Code plugin as a shell script wired from the marketplace. `uploads install`
already installed skills (and MCP for Claude) but never hooks, so Grok, Codex,
Cursor, and others never got the nudge.

**After:** shared `hooks/hooks.json` + CLI runtime; Claude/Codex plugins share
it; Grok/Cursor via `uploads install hooks`.

Skills travel via the Agent Skills convention. Hooks do not — there is no shared package format yet, only per-harness discovery paths that have started to converge.

## What exists today (landscape)

There is **no formal open standard** named “Agent Hooks Spec”. There is a **de facto lingua franca**: Claude Code’s event names, stdin JSON, and `hookSpecificOutput` output shape. Grok and Codex deliberately speak it. Cursor does not, but maps cleanly. GitHub Copilot is a third dialect.

### Compatibility matrix (relevant to this hook)

| Concern              | Claude Code                                              | Grok                                                                                                     | Codex                                                                         | Cursor                                                              | GitHub Copilot                 |
| -------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------ |
| Config path          | Plugin `hooks/hooks.json` or `.claude/settings.json`     | `~/.grok/hooks/*.json`, project `.grok/hooks/`, **plus** Claude + Cursor settings (compat on by default) | `~/.codex/hooks.json`, project `.codex/hooks.json`, plugin `hooks/hooks.json` | `~/.cursor/hooks.json`, project `.cursor/hooks.json`                | `.github/hooks/*.json`         |
| Event for shell      | `PreToolUse` + matcher `Bash`                            | Same; aliases `Bash` → `run_terminal_command`                                                            | Same; shell tools match as `Bash`                                             | `beforeShellExecution` (also maps to PreToolUse if harness is Grok) | `preToolUse` / camelCase tools |
| Stdin command field  | `tool_input.command` (snake)                             | `toolInput.command` (camel) _or_ Claude snake when source is Claude                                      | `tool_input.command` (Claude-compatible)                                      | top-level `command`                                                 | `toolArgs` / different tools   |
| Advisory context out | `hookSpecificOutput.additionalContext` + `systemMessage` | Accepts Claude shape; camelCase stdin differs                                                            | Same Claude shape                                                             | `additional_context` / `agentMessage` (flat)                        | `additionalContext` (flat)     |
| Plugin root env      | `CLAUDE_PLUGIN_ROOT`                                     | `GROK_PLUGIN_ROOT` + Claude aliases                                                                      | `PLUGIN_ROOT` + Claude aliases                                                | none (paths relative to hooks.json)                                 | none                           |
| Trust gate           | settings / plugin install                                | project folder-trust for project hooks                                                                   | `/hooks` review + hash trust for non-managed                                  | Settings → Hooks                                                    | committed to default branch    |
| Fail-open on error   | yes (typical)                                            | yes                                                                                                      | yes (unless explicit deny)                                                    | depends                                                             | depends                        |

Sources: Claude plugin-dev skill; Grok user guide `10-hooks.md` / `09-plugins.md` / `05-configuration.md` harness-compat; Codex hooks docs (learn.chatgpt.com/codex/hooks); Impeccable + Vercel plugin multi-platform adapters in the wild.

### What this means for the screenshot reminder

The hook is **advisory PreToolUse on shell** when the command contains `gh pr create`. That maps to every serious harness:

1. **Claude / Grok / Codex** — one script, Claude-shaped I/O, matcher `Bash` (Grok also hits `run_terminal_command` via alias).
2. **Cursor** — same logic, `beforeShellExecution`, different stdin/stdout envelope.
3. **Copilot** — same idea later; different tool names and payload; not required for v1.

Grok already **scans Claude and Cursor hook sources** when `[compat.claude] hooks = true` / `[compat.cursor] hooks = true` (defaults). That does **not** auto-load Claude _marketplace plugins_ into Grok — only settings-level and Grok plugin / `.grok/hooks/` discovery. Relying on “install the Claude plugin, use Grok” is incomplete.

## Goals

1. Same behavior on Claude, Grok, and Codex with one implementation.
2. Cursor support without a second logic tree.
3. Install path that does not require each user to invent a hooks.json.
4. Keep fail-open, `UPLOADS_HOOK_DISABLE=1`, and zero blocking of `gh pr create`.
5. No new npm runtime dependency for the hot path; Node is already assumed (the shell script already shells out to `node`).

## Non-goals

- A universal industry standard we invent and wait for others to adopt.
- Prompt-type hooks (LLM-judged); this hook stays deterministic.
- Blocking PR creation when screenshots are missing.
- Auto-promoting staged screenshots (webhook / attach path already owns that).
- Copilot cloud agent in v1 (document as follow-on).
- Shipping hooks inside Agent Skills (`npx skills`) — skills are not the right vehicle today.

## Recommended design

### Principle: one runtime, thin harness manifests, install via CLI

Industry practice that works (Impeccable, Vercel plugin):

1. **One shared hook implementation** that normalizes stdin/stdout across harnesses.
2. **Thin JSON manifests** per discovery location that only name the event, matcher, timeout, and command.
3. **Distribution outside pure Claude plugins** so Grok/Codex/Cursor get the same behavior.

### Principle: run via `uploads` on PATH, not `${CLAUDE_PLUGIN_ROOT}`

Today:

```json
"command": "sh ${CLAUDE_PLUGIN_ROOT}/hooks/pr-screenshot-reminder.sh"
```

That ties the hook to a Claude plugin install root. Codex and Grok set aliases when the hook is _plugin-bundled_, but:

- project/user hooks have no plugin root,
- Cursor has no `CLAUDE_PLUGIN_ROOT`,
- anyone with the CLI but not the Claude plugin is left out.

**Preferred command for every harness:**

```bash
uploads hook pre-pr-screenshot
```

Why this wins:

- `uploads` is already on PATH after `npm i -g @buildinternet/uploads` (the primary product install).
- The hook already requires `uploads find` to know if anything is staged — if the CLI is missing it fail-opens today.
- No `${CLAUDE_PLUGIN_ROOT}` / `${GROK_PLUGIN_ROOT}` / `${PLUGIN_ROOT}` path gymnastics.
- Versioned with the package; `uploads update` refreshes behavior without re-copying scripts into plugin caches.
- Easy to test: `echo '…' | uploads hook pre-pr-screenshot`.

Fallback when `uploads` is not on PATH (rare for our users): keep a thin shell/node entry under the repo for plugin-bundled installs that `exec`s the same code via `node path/to/dist/…` or `npx @buildinternet/uploads hook …`. Prefer PATH first.

### Shared runtime shape

Move logic out of the Claude-only shell script into a small Node module shipped with the CLI (same package as `uploads`):

```
packages/uploads/src/commands/hook.ts          # CLI entry: uploads hook <name>
packages/uploads/src/hooks/pre-pr-screenshot.ts  # pure logic + harness I/O
packages/uploads/src/hooks/normalize.ts          # parse stdin / format stdout
```

Keep a thin `hooks/pr-screenshot-reminder.sh` (or `.mjs`) in-repo only if plugin packaging still wants a file path; it should be a one-liner that execs `uploads hook pre-pr-screenshot`.

#### Input normalization

Accept all of:

| Source                        | Command path          |
| ----------------------------- | --------------------- |
| Claude / Codex                | `.tool_input.command` |
| Grok native                   | `.toolInput.command`  |
| Cursor `beforeShellExecution` | `.command`            |
| Explicit override             | env / future          |

Also tolerate `hook_event_name` / `hookEventName` and tool names `Bash` | `run_terminal_command` | shell-ish Cursor events (when Cursor still sends a generic preToolUse).

#### Output normalization

Detect harness (in order):

1. Explicit `UPLOADS_HOOK_HARNESS=claude|codex|grok|cursor`
2. Cursor: `conversation_id` or `workspace_roots` present, or top-level `command` without `tool_input`
3. Grok: `toolInput` camelCase without snake `tool_input`, or `GROK_SESSION_ID` set
4. Default: Claude/Codex shape (safe shared default)

Emit:

| Harness               | Advisory payload                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------- |
| Claude / Codex / Grok | `{ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext }, systemMessage }` |
| Cursor                | `{ additional_context, agentMessage }` (no `permission` — never block)                      |

Never set `permissionDecision: deny` / `permission: deny` for this hook.

#### Unchanged product behavior

Preserve from `pr-screenshot-reminder.sh`:

- Match word-boundary-ish `gh pr create` in the command string.
- Visual path heuristics (astro/tsx/…/css + `/email/`).
- Diff against default branch / merge-base.
- `uploads find gh.branch=<branch> --format json` with short timeout.
- Fork note via best-effort `gh repo view --json isFork`.
- Fail-open trap; `UPLOADS_HOOK_DISABLE=1`; `UPLOADS_HOOK_TEST_FILES` for tests.

### Manifests (thin)

#### Claude plugin (keep)

`plugins/claude/uploads/hooks/hooks.json`:

```json
{
  "description": "Advisory reminder to stage screenshots on uploads.sh before opening a PR that touches UI files.",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "uploads hook pre-pr-screenshot",
            "timeout": 15,
            "statusMessage": "Checking staged screenshots"
          }
        ]
      }
    ]
  }
}
```

Marketplace entry stays the same path.

#### Grok (user or project)

`~/.grok/hooks/uploads-pre-pr-screenshot.json` (install target) **or** project `.grok/hooks/…`:

Same Claude-shaped JSON (Grok accepts it). Matcher `Bash` also matches `run_terminal_command` via alias — no second matcher required.

Optional later: a Grok plugin under `plugins/grok/` with `hooks/hooks.json` for marketplace-style install. Not required for v1 if `uploads install hooks` writes `~/.grok/hooks/`.

#### Codex (user or project)

Codex uses the same wrapper (`description` + `hooks` events). Install to:

- `~/.codex/hooks.json` merged carefully, **or**
- a dedicated fragment if/when Codex supports multi-file user hooks the way Grok does (today Codex docs emphasize `hooks.json` + inline TOML; prefer merging into user `hooks.json` with an idempotent marker comment / named description, or install a small Codex plugin).

Codex requires `/hooks` trust on first run for non-managed hooks — document that.

Plugin path (optional v1.1): `.codex-plugin/plugin.json` with `"hooks": "./hooks/hooks.json"` and `PLUGIN_ROOT` unused because command is `uploads …`.

#### Cursor

`.cursor/hooks.json` fragment (install merges):

```json
{
  "version": 1,
  "hooks": {
    "beforeShellExecution": [
      {
        "command": "uploads hook pre-pr-screenshot",
        "timeout": 15
      }
    ]
  }
}
```

No matcher needed if the script exits 0 immediately when the command is not `gh pr create`. Optional matcher `"gh pr create"` if Cursor matchers apply to the command string (confirm at implement time against current Cursor docs).

### Distribution: extend `uploads install`

Today:

```
uploads install [skill|mcp|all]
```

Add:

```
uploads install [skill|mcp|hooks|all]
```

Default `all` becomes skills + mcp + hooks (or keep `all` = skill+mcp and document `hooks` as opt-in for one release — prefer **include in `all`** so multi-harness users get parity without reading a changelog).

What `hooks` does:

1. Detect available harnesses on the machine (presence of `~/.claude`, `~/.grok`, `~/.codex`, `~/.cursor`, or their CLIs).
2. For each present harness, write or merge the thin manifest:
   - Grok → `~/.grok/hooks/uploads-pre-pr-screenshot.json` (overwrite safe; single-file, our description)
   - Claude → no-op if marketplace plugin is the preferred path; **or** also write a user-level hook in `~/.claude/settings.json` only when the plugin is not installed (detect hard — simpler: always rely on plugin for Claude, install for Grok/Codex/Cursor)
   - Codex → merge into `~/.codex/hooks.json` under a stable matcher group (idempotent: detect our command string)
   - Cursor → merge into `~/.cursor/hooks.json` under `beforeShellExecution` (idempotent)
3. Print next steps: restart session; Codex users run `/hooks` and trust; Grok project hooks need `/hooks-trust` only if project-scoped.
4. `--dry-run` and `--verbose` already exist — reuse.

Prefer **user-global** install over project-committed hooks for the product CLI path (matches skills `-g`). Offer later:

```
uploads install hooks --project
```

to write `.grok/hooks/`, `.codex/hooks.json`, `.cursor/hooks.json` for team repos that want hooks in git.

### Claude plugin path stays first-class

Do not delete the marketplace plugin hook. Claude-first users who only run `/plugin install uploads@uploads` should keep getting the reminder without running `uploads install hooks`. The plugin manifest just points at `uploads hook …` instead of a script under `CLAUDE_PLUGIN_ROOT`.

If `uploads` is missing, fail-open (exit 0) — same as today when the CLI is absent.

### Tests

Port the manual `UPLOADS_HOOK_TEST_FILES` path into unit tests:

- pure function: given changed files + find result + command → message or empty
- normalize: Claude / Grok / Cursor fixtures → same internal command string
- format: same message → correct stdout per harness
- CLI: `echo fixture | uploads hook pre-pr-screenshot` exit 0 always on failure paths

Keep integration-style shell test optional.

### Docs / skill touch-ups

- `plugins/claude/uploads/README.md` — multi-harness section; disable still `UPLOADS_HOOK_DISABLE=1` (works in any env).
- `skills/github-screenshots/SKILL.md` — one line that agents may be nudged by a hook before `gh pr create`.
- `packages/uploads/README.md` + `uploads install` help text.
- Root `README.md` table row for hooks (not Claude-only).

## Alternatives considered

### A. Only rely on Grok’s Claude-compat scanner

Grok reads Claude settings hooks, not automatically every Claude marketplace plugin. Incomplete for Codex/Cursor. Rejected as sole strategy; keep as a free bonus when users do have Claude settings hooks.

### B. Copy the shell script into each plugin tree

Duplicates logic; path env differs per host; hard to version. Rejected for the implementation body; thin manifests only.

### C. Invent / wait for a shared Agent Hooks package format

Skills already have `npx skills`. Hooks do not. Waiting leaves the product worse for months. Implement to the de facto Claude-shaped core + Cursor adapter now; if a standard appears, our single runtime maps onto it.

### D. Project-only committed hooks in this monorepo

Helps this repo’s agents, not the broader audience of uploads.sh users. Still useful as a dogfood `--project` option later.

### E. HTTP hooks

Grok supports `type: "http"`. Nice for central policy, wrong for a local git-diff + CLI `find` check that needs the user’s workspace and credentials.

## Implementation plan (when building)

Phased so each step is shippable.

### Phase 1 — shared runtime in the CLI

1. Add `uploads hook pre-pr-screenshot` with normalize/format + existing product rules.
2. Unit tests with fixtures for Claude, Grok, Cursor stdin.
3. Point Claude plugin `hooks.json` at `uploads hook pre-pr-screenshot`.
4. Leave the old `.sh` as a deprecated wrapper or delete once green.

### Phase 2 — `uploads install hooks`

1. Extend install target enum and help.
2. Idempotent writers for Grok + Codex + Cursor user configs.
3. Dry-run output shows exact files and JSON diffs.
4. Document Codex trust + Grok folder-trust when using `--project`.

### Phase 3 — optional packaging polish

1. Codex plugin manifest if marketplace install becomes common.
2. Grok plugin under `plugins/grok/` for TUI marketplace users.
3. Copilot `.github/hooks/` adapter (Impeccable pattern).
4. Project-mode install for team repos.

### Suggested PR split

| PR  | Content                                         |
| --- | ----------------------------------------------- |
| 1   | Design doc (this file)                          |
| 2   | CLI hook command + tests + Claude plugin rewire |
| 3   | `uploads install hooks` + docs                  |

## Open questions

1. **Should `uploads install` (default `all`) include hooks immediately?** Recommendation: yes after Phase 1 is stable, so Grok/Codex users who already run install get the nudge without a second flag. Risk: writing `~/.codex/hooks.json` may surprise users who then must trust via `/hooks`. Mitigate with a clear post-install message.
2. **Idempotent merge strategy for Codex/Cursor single-file configs** — prefer detecting our exact command string and skipping if present; never clobber unrelated hooks.
3. **Windows** — Codex has `commandWindows`; our CLI is Node and cross-platform. Verify `uploads.cmd` on PATH; add `commandWindows` only if needed.
4. **Matcher breadth on Grok** — confirm in a live session that matcher `Bash` fires for `run_terminal_command` (docs say yes via alias). If not, dual matchers `Bash|run_terminal_command`.

## Success criteria

- Opening a PR via Claude, Grok, or Codex on a UI-touching branch with nothing staged produces the same advisory text.
- Cursor shell path does the same when hooks are enabled.
- Missing CLI, network, or git state never blocks `gh pr create`.
- `UPLOADS_HOOK_DISABLE=1` disables every harness.
- A user with only `npm i -g @buildinternet/uploads && uploads install` gets skills, MCP (where applicable), and hooks without installing the Claude marketplace plugin.

## Appendix: current Claude hook contract (baseline)

**Trigger:** PreToolUse, tool Bash, command contains `gh pr create`.  
**Condition:** branch diff touches visual paths; `uploads find gh.branch=…` empty.  
**Output:** non-blocking `additionalContext` + `systemMessage`.  
**Disable:** `UPLOADS_HOOK_DISABLE=1`.  
**Fail-open:** any uncertainty → exit 0, no stdout.
