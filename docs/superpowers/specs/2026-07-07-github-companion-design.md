# GitHub companion v1 — PR/issue attachments with stable URLs

**Date:** 2026-07-07
**Status:** Approved design, pre-implementation

## Goal

Make uploads.sh the natural place to attach files (screenshots, diagrams,
GIFs, artifacts) to GitHub pull requests and issues. The core trick: keys are
deterministic per PR/issue, so re-uploading a file with the same name
overwrites the same key — and every embed of that URL on GitHub updates
automatically. No GitHub App, no webhooks, no server-side GitHub credentials.

Primary user: agents (Claude Code and skills like `github-screenshots`),
which already have `git` context and an authenticated `gh` CLI. Humans using
the CLI directly get the same experience for free.

## Decisions made

| Question | Decision |
| --- | --- |
| First user | Agents (skills / Claude Code), humans second |
| Sync model | Stable URLs + optional comment posted via the agent's local `gh` auth. No server-side GitHub integration. |
| Key policy | Client-side convention only. API unchanged — `GET /v1/:ws/files?prefix=` already covers listing (`apps/api/src/routes/files.ts`). |
| Agent surface | Extend the existing CLI (`@buildinternet/uploads`) and update the `github-screenshots` skill. MCP server stays a later roadmap item. |

## Key convention (client-built)

```
gh/<org>/<repo>/pull/<num>/<filename>
gh/<org>/<repo>/issues/<num>/<filename>
```

- `org`/`repo` inferred from the git remote (prefer `gh repo view
  --json nameWithOwner`, fall back to parsing `origin`), overridable with
  `--repo org/name`.
- Same filename → same key → overwrite → stable URL. This is the
  auto-update mechanism; it requires nothing else.
- The convention lives entirely in the CLI. The API continues to accept
  arbitrary keys; server-side typed destinations remain a separate roadmap
  item and nothing here conflicts with adding them later.

## CLI additions (`packages/uploads`)

- `uploads put <file> --pr <num>` / `--issue <num>` — upload to the
  convention key; print the public URL **and** a ready-to-paste markdown
  embed (`![name](url)` for images, `[name](url)` otherwise).
- `uploads ls --pr <num>` / `--issue <num>` — list that PR/issue's
  attachments using the existing `?prefix=` query.
- `uploads comment --pr <num>` (also `put … --comment`) — create or update
  a single managed comment on the PR/issue listing all current attachments
  (image files rendered inline). The command finds its own comment via a
  hidden marker (`<!-- uploads.sh:attachments -->`) and edits it in place via
  `gh api`; it never touches other comments or the PR description.

`--pr`/`--issue` are mutually exclusive. `--repo` applies to all three
commands.

## Graceful degradation

- No git remote and no `--repo` → error asking for `--repo`. Upload never
  guesses.
- `gh` missing or unauthenticated → the upload still succeeds and markdown
  still prints; the comment step is skipped with a warning. Uploads never
  depend on GitHub being reachable.
- `--comment` on a PR/issue that doesn't exist → surface the `gh` error;
  the file is already uploaded and its URL printed.

## Interaction with shared-bucket workspace prefixes

Designed alongside `2026-07-07-shared-bucket-workspace-prefixes-design.md`
(in progress in parallel). The two compose without changes to either:

- The workspace prefix is applied transparently in the storage layer;
  `gh/…` keys here are **client keys** (workspace-relative). A
  shared-bucket workspace stores them at `<ws>/gh/…` and `?prefix=`
  listing still operates on client keys, so `uploads ls --pr` is
  unaffected.
- Public URLs stay stable and deterministic
  (`https://storage.uploads.sh/<ws>/gh/org/repo/pull/123/shot.png`), so the
  replace-updates-embeds mechanism is untouched. Constraint: the CLI must
  always use the API-returned `url` and never compose URLs from
  `publicBaseUrl` client-side (the client already behaves this way).
- Intentional divergence from the existing screenshot key scheme:
  `buildScreenshotKey` in `packages/uploads/src/keys.ts` appends a content
  hash to filenames, which defeats URL stability. `--pr`/`--issue` keys use
  plain filenames with **no content hash** by design; the hashed scheme
  remains for non-PR/issue puts.

## Skill update

Point the `github-screenshots` skill at `uploads put --pr` instead of its
bespoke R2 upload scripts (existing roadmap item). The skill decides
per-invocation whether to pass `--comment`; it is not default-on.

## Explicitly deferred

- Server-side typed destinations / per-workspace key policy
- Auto-expiry of attachments after PR close (lifecycle rules)
- MCP server (`attach_to_pr` tool) — planned, separate effort
- GitHub App / webhooks / server-side comment sync

Nothing in v1 blocks any of these.

## Testing

- Unit tests: key construction, repo inference (remote parsing + `--repo`
  override), markdown snippet generation, managed-comment body generation.
- The `gh` interaction goes behind a small wrapper module so find-or-create
  comment logic is testable without network.
- One manual end-to-end pass against a real test PR: upload, embed, replace
  the file, confirm the embed updates; run `comment` twice and confirm it
  edits rather than duplicates.
