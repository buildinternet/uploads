# `uploads update` command — design

Date: 2026-07-23

## Problem

A user who wanted the newest agent behavior — the pre-PR hooks and the
branch-staged uploads that the GitHub App posts on PR open — did not know how
to get it. Their first guess was `uploads update`, which does not exist. Their
second guess was `npm update` plus `uploads install`, which is correct.

The guess was close to right, so the gap is not that npm is hard. The gap is
that two separate artifacts go stale, and nothing tells the user that:

1. The npm package that provides the `uploads` binary.
2. The agent skills and the MCP server registration, which `uploads install`
   writes.

`uploads update` earns its place as the one verb that covers both. It also
makes the existing update notice actionable: the hint can name a command the
user runs directly, instead of a package name they must remember.

## Prior art

Most npm-distributed CLIs do not self-update. `gh`, `wrangler`, `vercel`,
`netlify`, `supabase`, `stripe`, and `firebase` print a notice and leave the
upgrade to the package manager. That is what this CLI does today.

Two precedents support adding the command anyway:

- `claude update` is npm-distributed and self-updates. Claude Code is the
  environment most of our users run in, so the verb is familiar to them.
- `gh extension upgrade` exists because installed add-ons drift separately
  from the binary. Our skills and MCP registration have the same problem.

## Command surface

```
uploads update [--dry-run] [--skip-install] [--verbose]
```

The command runs three phases: upgrade the CLI, refresh the skills and MCP
registration, then report the result. It sits beside `install` and `doctor` in
the command catalog and is marked `essential`, so it appears in default help.

| Flag             | Effect                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------- |
| `--dry-run`      | Print the plan and exit without running anything.                                       |
| `--skip-install` | Upgrade the npm package only; do not refresh skills or MCP.                             |
| `--verbose`      | Show the output of the underlying commands. Errors only by default, matching `install`. |

There is no `--format json`. Nothing consumes machine-readable output from an
update command.

There is no confirmation prompt and no `--yes` flag. `deno upgrade`,
`bun upgrade`, `rustup update`, and `claude update` all run without asking.
`--dry-run` covers the case where a user wants to see the plan first.

## Flow

1. **Detect the install source.** Resolve the real path of the running module
   and classify it: a global install, an `npx` cache entry, or a workspace
   checkout.
2. **Check the version.** Call `checkForUpdate({ ttlMs: 0 })` from
   `update-check.ts`. The zero TTL forces a fresh registry read, because
   `update` must not trust the previous day's cache.
3. **Print the plan.** Every command appears verbatim before anything runs.
   `--dry-run` stops here.
4. **Upgrade.** Run the detected package manager's global install. This step
   is skipped when the CLI is already current, and when the install source is
   not a global install.
5. **Refresh.** Re-run the `install` command. When step 4 upgraded the
   package, this spawns the newly installed binary rather than calling the
   install code in process, so the new version's skill list is the one that
   runs. When step 4 was skipped, nothing changed, so the install command runs
   in process.
6. **Summarize.** Report what ran and what was skipped.

An already-current CLI is a first-class path, not an early exit. The command
prints `CLI already at <version>` and still runs the refresh, because the
skills and the MCP registration drift on their own.

## Install source detection

`detectInstallSource` is a pure function over a resolved path and the
environment. It returns the install kind and, for global installs, the
package manager and its upgrade command.

The safety-critical output is the kind, not the manager. Without it,
`pnpm uploads update` inside this monorepo would overwrite the developer's
build with the published version. When the source is not a global install, the
command skips the upgrade, explains why, and still offers the refresh.

Manager detection covers npm, pnpm, and bun. Anything unrecognized falls back
to npm. Yarn is out of scope, because current yarn versions do not install
global binaries.

## Error handling

A failed upgrade aborts before the refresh and exits non-zero, printing the
exact command to run by hand. A refresh that runs against a failed upgrade
produces a confusing half-applied state, and re-running `uploads update` costs
the user nothing.

`EACCES` on a global install gets a dedicated message instead of a raw npm
error dump. A missing `npx` or `claude` binary reuses the `ENOENT` handling
that `install` already has.

## Files

| File                                          | Change                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/uploads/src/install-source.ts`      | New. Pure `detectInstallSource`.                                                                   |
| `packages/uploads/src/commands/update.ts`     | New. Orchestration, reusing `install.ts`'s `StepResult`, `runStep`, and `CommandRunner` injection. |
| `packages/uploads/src/commands/install.ts`    | Export the step logic so `update` calls it instead of duplicating it.                              |
| `packages/uploads/src/update-check.ts`        | Hint becomes `Update: uploads update`.                                                             |
| `packages/uploads/src/cli-brand.ts`           | Update banner becomes `uploads update`.                                                            |
| `packages/uploads/src/cli-catalog.ts`         | Register the command as essential.                                                                 |
| `packages/uploads/src/commands.ts`            | Wire up the dispatch.                                                                              |
| `packages/uploads/src/commands/completion.ts` | Add the command.                                                                                   |
| `docs/cli.md`                                 | Document the command.                                                                              |
| `apps/web/src/lib/cli-upgrade.ts`             | Account-page callout says `uploads update`.                                                        |

## Testing

The repo uses vitest with in-process fakes.

- Table-driven tests for `detectInstallSource` across npm, pnpm, bun, npx, and
  workspace paths.
- Plan-construction tests for three cases: current, outdated, and non-global.
- Injected-runner tests that assert the exact command sequence, including that
  the refresh spawns the new binary only after an upgrade ran.

## Out of scope

**The Claude plugin.** The hooks ship only in
`plugins/claude/uploads/hooks/hooks.json`, which reaches users through the
plugin marketplace. Neither `npm update` nor `uploads install` installs them.
`update` does not manage the plugin.

**Website install copy.** The site keeps `npm install -g`, because a user with
no binary cannot run `uploads update`. The account-page callout is the
exception: those users demonstrably have the CLI.

**The overlap warning.** The plugin and `uploads install` both provide the same
two skills, and they register competing MCP servers — local against hosted.
Detecting that is a health check, so it belongs in `uploads doctor`, not in
`update`.

## Follow-ups

1. Document the plugin as the only source of the hooks. No page in `docs/`,
   `README.md`, or the site mentions the plugin install path today.
2. Decide whether the plugin or `uploads install` is the canonical install
   path, and add the overlap check to `uploads doctor`.
