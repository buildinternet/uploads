# GitHub-native attachment ingestion

**Date:** 2026-08-11
**Status:** Approved design, pre-implementation
**Delivery:** Orchestrated agents (see Delivery notes)

## Problem

People drag screenshots and screen recordings directly into GitHub PR/issue
descriptions and comments (`github.com/user-attachments/...`). Those assets are
invisible to uploads.sh: they don't appear in `find_files`, the Screenshots
page, or any "latest screenshot for this PR" query. This feature mirrors them
into the linked workspace so GitHub-native uploads participate in the same
index as CLI/MCP uploads.

## Decisions (settled during brainstorming)

- **Trigger:** automatic via webhook, **opt-in per repo** (plus a manual
  on-demand path — see below).
- **Managed comment:** ingested assets are **index-only**; they never join the
  managed attachments comment (they're already visible inline on GitHub).
- **Media scope:** images and video/GIF — anything GitHub renders as media.
- **Sources:** PR/issue **bodies + issue/PR comments**. Inline code-review
  comments (`pull_request_review_comment`) are out of scope.
- **Removal/replacement:** soft-detach, never auto-delete (see Reconciliation).

## Architecture

One reconciliation core, two triggers:

1. **Webhook path (automatic, opt-in).** The existing webhook handler
   ([apps/api/src/github-webhook.ts](../../../apps/api/src/github-webhook.ts))
   already normalizes `issues`, `pull_request`, and `issue_comment` events. For
   opted-in linked repos, it additionally enqueues ingest work on the existing
   webhook queue (new message kind; per-message ack/retry already exists —
   [apps/api/src/github-webhook-queue.ts](../../../apps/api/src/github-webhook-queue.ts)).
   `issue_comment deleted` detaches everything that comment referenced.
2. **Manual path (on demand, any linked repo).** `POST /v1/github/ingest`
   with `{ repo, pr | issue }`, authenticated by session or workspace token,
   gated on the repo being linked to the caller's workspace. Fetches the
   current body + all comments via the installation token and runs the same
   reconcile inline, returning `{ ingested, detached, skipped: [{url, reason}] }`.
   Manual invocation is itself consent: it works regardless of the repo
   opt-in knob. CLI: `uploads ingest --pr <n> | --issue <n>` (repo inferred
   from git remote, `--format json` supported). Doubles as backfill and
   webhook repair.

### Opt-in configuration

- `.uploads.yml`: new flat camelCase knob `ingestGithubAttachments: true`
  (default false), alongside the existing comment knobs. Workspace-level
  default `ingestGithubAttachments` in workspace settings, same repo →
  workspace → auto layering as comment options.
- **Sync constraint:** the repo-config parser exists in two deliberately
  duplicated copies (`packages/comment-config/src/index.ts` and
  `packages/uploads/src/comment-config.ts`), kept honest by
  `test/fixtures/comment-config-golden.json` asserted from both sides. The new
  knob must land in both copies + the golden fixture in the same change.

### Extraction

From the changed body/comment Markdown, extract
`https://github.com/user-attachments/assets/<uuid>` (and the
`.../user-attachments/files/...` form if present) in all shapes: bare URL,
Markdown image/link, HTML `<img>`, `<video src>`. The asset UUID is the stable
identity.

### Ledger & reconciliation

New D1 table (ingest ledger), one row per (repo, asset UUID), recording:
object key, source anchor (comment id or `body` + issue/PR number), first-seen,
and `detached_at` (nullable).

Every scan of a source is a full reconcile of that source, not an append:

- UUID present in text, not in ledger → **ingest** (fetch + store + row).
- UUID present in text, ledger row detached → **re-attach** (clear
  `detached_at` + metadata flag; no re-fetch).
- UUID in ledger for this source, absent from text → **detach** (set
  `detached_at`, stamp metadata so default queries exclude it).
- Bytes are never auto-deleted. Detached files remain in the file table and
  are deletable through the existing member delete flow. A future reaper
  policy for old detached assets is explicitly out of scope.

The ledger's uniqueness key makes concurrent webhook/manual runs idempotent;
no additional locking.

### Fetch & store

- Fetch the asset URL with the **installation token** (private-repo assets
  404 unauthenticated), following the redirect to the signed CDN URL. Trust
  the response `Content-Type`, not the URL.
- **Pre-write guards** (same family as hosted MCP `put`): media-type
  allowlist (image/video), per-file size cap and video-cap ceiling from the
  workspace's plan limits, budget check. Guard failures are **permanent
  skips** with a structured log — never retried into the dead-letter path.
- **Key layout:** `gh/{owner}-{repo}/{pull|issues}-{num}/{uuid}.{ext}` in the
  linked workspace — collision-free and clearly separate from user-chosen keys.
- **Write path:** through files-core (content-hash inheritance, usage
  accounting, file table all apply), never a bare R2 put.

### Metadata

Reuse the existing lowercase `gh.*` vocabulary: `gh.repo`, `gh.kind`
(`pull`/`issues`), `gh.number`, plus:

- `gh.origin=github` — distinguishes mirrored assets from deliberate CLI/MCP
  uploads; the include/exclude knob for queries.
- `gh.author=<github-login>` — the human who posted the attachment. A new key:
  `gh.uploader` is server-derived from the bearer token's minting identity and
  must not be overloaded.
- `gh.detached=false|true` — always stamped (initially `false`) so the
  default "current screenshots" exclusion is a plain equality filter
  (`meta.gh.detached=false`), matching the filter API's equality-only shape.
  Not `gh.status`: that key is the staged/promoted staging state machine and
  ingested files are not part of it.
- Source anchor (comment id or `body`) so detach reconciliation can scope by
  source.

No derived `path`/`state` tier — we can't know what the screenshot depicts.

Uploader identity (attribution) is the bot; the human stays in metadata.

## Surfacing

- Mirrored files appear in `find_files`/search, the file table, and the
  Screenshots page — in an ungrouped section (no `path` metadata) — filtered
  to non-detached by default; `gh.origin=github` available as an explicit
  filter both ways.
- `/f/` pages work as normal files. The managed comment ignores them.

## Testing

- **Unit:** URL extraction across all four shapes; reconcile diffing
  (add / remove / re-add / replace / comment-delete); guard skips (oversize,
  non-media, over budget) proving permanent-skip semantics.
- **Integration:** existing fake-D1 + webhook-queue harness extended with a
  fake `user-attachments` origin (redirect + bytes); opt-in gating (knob off →
  no enqueue); manual endpoint through the same fakes, both PR and issue.
- **CLI:** `uploads ingest` against the fake API like other CLI command tests.

## Delivery notes

Implementation will be orchestrated across agents. Natural seams:

1. Config knob (both parser copies + golden fixture + workspace default).
2. Ledger table + reconcile core + extraction (pure, heavily unit-tested).
3. Webhook wiring (detection, enqueue, consumer message kind).
4. Fetch/store pipeline with guards.
5. Manual API endpoint.
6. CLI command.
7. Surfacing filters (Screenshots page / find_files detached handling).

2 depends on nothing; 3–5 depend on 2; 6 depends on 5; 7 is independent of
3–6 once metadata keys are fixed. Migration lands via the normal D1
auto-apply-on-merge flow — no manual wrangler step.
