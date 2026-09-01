# Branch-rename follow for staged uploads (issue #920)

## Problem

Files staged with `uploads attach --branch` (or `put` on a branch) live under
`gh/<owner>/<repo>/branch/<branch>/…` (plain repos) or under a per-branch private prefix
(`github_private_prefixes` row keyed by branch name). Renaming the branch before its PR opens
strands them: auto-promote sweeps the new name and finds nothing. PR #919 added the manual
escape hatch (`attach --from-branch <old>`). This work makes the common case automatic.

## Decision: CLI-side detection, no new App permission

Server-side detection needs `push`/`create`/`delete` webhooks, and all three require the
GitHub App to ask for `Contents: read`, which installers see as "read access to code". That is
deliberately not requested. Instead the CLI reads the branch reflog: `git branch -m old new`
writes `Branch: renamed refs/heads/old to refs/heads/new` into the new branch's reflog, and
chained renames accumulate there. The CLI registers each rename with the server; promote sweeps
the branch's whole name lineage.

Known limitation: a rename followed by opening a PR without running `uploads` again is not
followed (the #919 escape hatch covers it). There is no "branch deleted / orphaned" status; that
needs the webhook and is out of scope. The alias table is shaped so a webhook detector can be
added later (`source` column) without a schema change.

## Server

### D1 migration `apps/api/migrations/20260901120000_github_branch_renames.sql`

```sql
CREATE TABLE github_branch_renames (
  workspace      TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,                  -- lowercased owner/name
  old_branch     TEXT NOT NULL COLLATE NOCASE,   -- stored verbatim (plain prefixes are case-preserving)
  new_branch     TEXT NOT NULL COLLATE NOCASE,
  source         TEXT NOT NULL,                  -- 'cli-reflog' today; 'webhook-push' reserved
  recorded_at    TEXT NOT NULL,
  PRIMARY KEY (workspace, repo_full_name, old_branch, new_branch)
);
CREATE INDEX github_branch_renames_new_idx
  ON github_branch_renames (workspace, repo_full_name, new_branch);
```

Scoped by workspace on purpose: a rename only ever widens which of the _calling_ workspace's
own staged prefixes a promote sweeps, so one workspace cannot influence another's promote.

### Access layer `apps/api/src/github-branch-renames.ts`

- `recordBranchRename(db, { workspace, repo, from, to, source, now? }): Promise<{ recorded: boolean }>`
  — `INSERT OR IGNORE`; `recorded:false` when the row already existed. Rejects `from`
  equal to `to` case-insensitively.
- `resolveBranchLineage(db, workspace, repo, branch): Promise<string[]>` — returns
  `[branch, ...older names]`, walking `new_branch → old_branch` breadth-first, depth cap 8,
  total cap 16, cycle-safe, case-insensitive dedupe. `[branch]` when the table is empty.

### Route `POST /v1/workspaces/:workspace/github/branch-rename`

Body `{ repo, from, to }`. Same `repo` grammar and branch validation as the promote route
(printable ASCII, ≤512). Write scope, `writeRateLimit`. Mounted in the canonical dual-auth
vertical (`routes/workspace-github.ts`) next to `github/promote`; handler extracted like
`githubPromoteHandler`. Response `200 { recorded: boolean }`. 400 `invalid_repo` /
`invalid_branch` / `same_branch`.

### Promote

`promoteBranchAttachments` resolves the lineage for `target.branch` and sweeps, in lineage
order: the plain prefix for every name, and (when the head resolves to private mode) the
private prefix of every name that has an active `github_private_prefixes` row, using
`getActivePrefixId` (never mint for older names). Existing dedupe-by-filename rules stay;
ties across names resolve to the earliest lineage position (the current name wins).
`PromoteResult` gains optional `lineage?: string[]` when longer than one entry, so the CLI
can print "followed rename from X".

Fail-open: a lineage lookup error logs and falls back to `[branch]`.

## CLI (`packages/uploads`)

- `github-gh.ts`: `renameLineageFromReflog(run, branch): Array<{ from: string; to: string }>`
  — runs `git reflog show --format=%gs refs/heads/<branch>`, parses
  `^Branch: renamed refs/heads/(.+) to refs/heads/(.+)$`, returns pairs oldest-first. Empty on
  any git error.
- `client.ts`: `registerBranchRename({ repo, from, to })` hitting the new route.
- `registerRenamesBestEffort(client, run, repo, branch)` helper in `commands.ts`: no-op when
  the lineage is empty; swallows network errors (debug-level note only). Called wherever the
  CLI resolves the current branch for a GitHub staging or promote operation: `attach --branch`
  staging, `put` branch staging, `attach --pr` default promote, `attach --promote`, and the
  pre-PR auto-promote path. Not called on `--from-branch` (manual override).
- Promote output prints `>> followed rename from <old>` when the result carries a lineage.

## MCP

- Hosted MCP `promote` already takes an explicit `branch`; no change.
- Stdio MCP `attach` today uploads and syncs the comment but never promotes. Add CLI parity:
  with `pr`, best-effort promote the current branch's staged files (result under `promotion` /
  `promoteError`, same shape as hosted `put`), `fromBranch` string override (mirrors
  `--from-branch`), `noPromote` boolean opt-out. The reflog registration runs before the
  default promote, as in the CLI.

## Docs

- `apps/web/src/content/docs/github-app.mdx` permissions section: one sentence that rename
  following is done by the CLI so the App does not need `Contents: read`, with the limitation.
- `apps/web/src/content/docs/attach-pull-request-images.mdx`, `docs/cli.md`,
  `skills/github-screenshots/SKILL.md`, `skills/uploads-cli/SKILL.md`: renamed branches are
  followed automatically once you run `uploads` again; `--from-branch` remains the fallback.
- Changeset for `uploads` (CLI package only; platform is not changeset-tracked).

## Testing

- API: access-layer tests with the fake D1 (record, ignore duplicate, lineage BFS with chain
  and cycle); route test (validation, 200 shape); promote tests: plain lineage sweep, private
  lineage sweep, dedupe preference, empty table unchanged.
- CLI: reflog parser unit test (fixture lines incl. chained rename and unrelated entries);
  attach/promote command tests asserting the register call is made with the fake runner and
  that a failing register does not fail the command.
- MCP: stdio attach promote + fromBranch + noPromote tests.
