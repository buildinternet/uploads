# GitHub-Native Attachment Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-08-11-github-attachment-ingestion-design.md`

**Goal:** Mirror `github.com/user-attachments` assets from PR/issue bodies and comments into the linked workspace so GitHub-native uploads appear in `find_files`, search, and the Screenshots page.

**Architecture:** One reconciliation core (`apps/api/src/github-ingest.ts`) with two triggers: a new `ingest` field on the existing webhook-queue `WebhookEvent` (automatic, gated by a new `ingestGithubAttachments` repo/workspace knob), and a manual `POST /v1/workspaces/:workspace/github/ingest` endpoint (+ `uploads ingest` CLI). A D1 ledger table keyed by (repo, asset id) makes every reconcile idempotent; removal soft-detaches (`gh.detached=true`) and never deletes bytes.

**Tech Stack:** Cloudflare Workers (Hono), D1, R2, Queues; vitest with the repo's fake-D1/fake-R2 harness; the published `uploads` CLI package.

## Global Constraints

- The `.uploads.yml` parser exists in TWO deliberately duplicated copies — `packages/comment-config/src/index.ts` and `packages/uploads/src/comment-config.ts` — kept honest by `test/fixtures/comment-config-golden.json`. Any parser change lands in both copies + the fixture in the same task.
- Queue messages are compact field-extractions, never raw GitHub payloads (128 KB cap). The ingest message carries a source _reference_; the consumer re-fetches current text.
- `extractWebhookEvent` is pure (no I/O). All gating that needs DB/KV happens in the consumer.
- Guard failures (non-media, oversize, over budget, asset 404) are **permanent skips** with a structured log — they must never `throw` into the queue retry path. Network failures / GitHub 5xx **do** throw (retry).
- Metadata keys must match `META_KEY_RE = /^[a-z][a-z0-9._-]{0,63}$/`, values ≤ 512 bytes, ≤ 24 keys total. New keys: `gh.origin=github`, `gh.author=<login>`, `gh.detached=false|true` (always stamped), `gh.source=body|comment:<id>`. Existing keys reused: `gh.repo`, `gh.kind`, `gh.number`. Never stamp `gh.uploader`/`gh.uploader-id` (server-derived elsewhere).
- Never call `replaceFileMetadata` to flip one key (delete-then-insert wipes server-owned `video.*` rows). Task 4 adds a targeted single-key update helper.
- All writes go through `putObject` (files-core) — never bare R2 puts.
- Object keys live under the managed prefix: `gh/{owner}-{repo}/{pull|issues}-{num}/{assetId}.{ext}` (`isManagedGithubKey` → replace always allowed).
- D1 migration naming: `YYYYMMDDHHMMSS_snake_case.sql` in `apps/api/migrations/`. Migrations auto-apply on merge to main — no manual wrangler step.
- CLI changes need a changeset for the published CLI package only (an ignored-package changeset silently blocks all publishes).
- Commit style: `feat(api): …` / `feat(cli): …` etc., no sensational adjectives.
- Run tests with `pnpm vitest run <file>` from the repo root (plain vitest, no pool-workers).

---

### Task 1: `ingestGithubAttachments` config knob

**Files:**

- Modify: `packages/comment-config/src/index.ts`
- Modify: `packages/uploads/src/comment-config.ts` (byte-for-byte same parser edits)
- Modify: `test/fixtures/comment-config-golden.json`
- Modify: `apps/api/src/repo-comment-config.ts` (`workspaceCommentDefaults`)
- Modify: `apps/api/src/workspace.ts` (WorkspaceRecord field `githubIngestAttachments?: boolean`)
- Modify: `apps/api/src/routes/workspace-settings.ts` (PATCH accepts the new boolean)
- Test: `packages/comment-config/src/index.test.ts`, `packages/uploads/test/comment-config.test.ts` (golden-fixture driven), plus the workspace-settings route test file that covers other boolean knobs

**Interfaces:**

- Consumes: existing `RepoCommentConfig` / `WorkspaceCommentDefaults` / `ResolvedCommentOptions` / `resolveCommentOptions` / `parseRepoCommentConfig`.
- Produces: `ResolvedCommentOptions.ingestGithubAttachments: boolean` (default `false`), resolvable repo → workspace → auto. `WorkspaceRecord.githubIngestAttachments?: boolean`. Task 5 reads `options.ingestGithubAttachments` via `resolveRepoCommentOptions(env, ws, repo)`.

- [ ] **Step 1: Add golden-fixture cases (the failing test)**

Append to `parseCases` in `test/fixtures/comment-config-golden.json`:

```json
{
  "name": "ingestGithubAttachments true",
  "text": "ingestGithubAttachments: true\n",
  "format": "yaml",
  "expected": { "config": { "ingestGithubAttachments": true }, "warnings": [] }
},
{
  "name": "ingestGithubAttachments non-boolean warns",
  "text": "ingestGithubAttachments: yes please\n",
  "format": "yaml",
  "expected": { "config": null, "warnings": ["ingestGithubAttachments: expected true or false"] }
}
```

(Match the exact warning-string style of the existing boolean knobs — read how `linkToFilePage` warns first and copy that phrasing; adjust the fixture to match.)

Append to `resolveCases`:

```json
{
  "name": "ingest knob repo over workspace",
  "repo": { "ingestGithubAttachments": true },
  "workspace": { "ingestGithubAttachments": false },
  "expected": {
    "options": {
      "imageWidth": "auto",
      "maxInlineImages": 16,
      "metaPath": true,
      "metaState": true,
      "linkToFilePage": true,
      "note": null,
      "ingestGithubAttachments": true
    },
    "source": {
      "imageWidth": "auto",
      "maxInlineImages": "auto",
      "metaPath": "auto",
      "metaState": "auto",
      "linkToFilePage": "auto",
      "note": "auto",
      "ingestGithubAttachments": "repo"
    }
  }
}
```

Also update every EXISTING `resolveCases` expectation: each gains `"ingestGithubAttachments": false` in `options` and `"ingestGithubAttachments": "auto"` in `source` (the resolver returns every key).

- [ ] **Step 2: Run both golden-driven suites to verify they fail**

Run: `pnpm vitest run packages/comment-config/src/index.test.ts packages/uploads/test/comment-config.test.ts`
Expected: FAIL (unknown key warning / missing field in resolved options).

- [ ] **Step 3: Implement the knob in the canonical parser**

In `packages/comment-config/src/index.ts`:

- `RepoCommentConfig`: add `ingestGithubAttachments?: boolean;`
- `WorkspaceCommentDefaults`: add `ingestGithubAttachments?: boolean;`
- `ResolvedCommentOptions`: add `ingestGithubAttachments: boolean;`
- `AUTO_COMMENT_OPTIONS`: add `ingestGithubAttachments: false,`
- `parseRepoCommentConfig`: add a boolean-parse branch identical in shape to `linkToFilePage`'s (accept `true`/`false`, warn otherwise).
- `resolveCommentOptions`: add `"ingestGithubAttachments"` to the `apply` loop's key list; in the `wsAsRepo` conversion map `ws.ingestGithubAttachments` straight through (plain boolean, no fan-out).

- [ ] **Step 4: Mirror the exact same edits into `packages/uploads/src/comment-config.ts`**

The two files must stay copy-identical in the shared region. Apply the same diff.

- [ ] **Step 5: Run both suites to verify they pass**

Run: `pnpm vitest run packages/comment-config/src/index.test.ts packages/uploads/test/comment-config.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire the workspace default in the API**

In `apps/api/src/workspace.ts` add to `WorkspaceRecord` (next to the other `githubComment*` fields):

```ts
/** Workspace default for the repo `ingestGithubAttachments` knob (issue-spec 2026-08-11). */
githubIngestAttachments?: boolean;
```

In `apps/api/src/repo-comment-config.ts` `workspaceCommentDefaults(ws)`, add:

```ts
ingestGithubAttachments: ws.githubIngestAttachments,
```

In `apps/api/src/routes/workspace-settings.ts`, extend the PATCH handler to accept `githubIngestAttachments` exactly like the existing boolean knobs (`githubCommentLinkToFilePage` is the template: type-check boolean, write via the versioned `mutateWorkspaceRecord` path the route already uses). Add a PATCH test case in the existing workspace-settings test file asserting the field round-trips and rejects non-booleans.

- [ ] **Step 7: Run API config + settings tests**

Run: `pnpm vitest run apps/api/src/repo-comment-config.test.ts apps/api/test/routes-workspace-settings.test.ts` (adjust to the actual settings test filename found in `apps/api/test/`).
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/comment-config packages/uploads/src/comment-config.ts test/fixtures/comment-config-golden.json apps/api/src
git commit -m "feat(config): ingestGithubAttachments repo/workspace knob"
```

---

### Task 2: Ingest ledger (migration + module)

**Files:**

- Create: `apps/api/migrations/20260811120000_github_ingested_assets.sql`
- Create: `apps/api/src/github-ingest-ledger.ts`
- Create: `apps/api/test/github-ingest-ledger-sqlite.test.ts`
- Create: `apps/api/test/helpers/fake-ingest-ledger-table.ts`
- Modify: `apps/api/test/usage-fake-d1.ts` (wire the fake table in)

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces (Task 4 depends on these exact signatures):

```ts
export interface IngestLedgerRow {
  repo: string; // lowercase owner/name
  assetId: string; // path after /user-attachments/, e.g. "assets/<uuid>" or "files/123/shot.png"
  workspace: string;
  objectKey: string;
  kind: "pull" | "issues";
  num: number;
  source: string; // "body" | "comment:<id>"
  createdAt: string; // ISO
  detachedAt: string | null;
}
export async function ledgerRowsForSource(
  db: D1Database,
  repo: string,
  source: string,
): Promise<IngestLedgerRow[]>;
export async function ledgerRow(
  db: D1Database,
  repo: string,
  assetId: string,
): Promise<IngestLedgerRow | null>;
export async function recordIngestedAsset(
  db: D1Database,
  row: Omit<IngestLedgerRow, "detachedAt">,
): Promise<void>;
export async function setLedgerDetached(
  db: D1Database,
  repo: string,
  assetId: string,
  detachedAt: string | null,
): Promise<void>;
export async function setLedgerSource(
  db: D1Database,
  repo: string,
  assetId: string,
  source: string,
): Promise<void>;
```

- [ ] **Step 1: Write the migration**

`apps/api/migrations/20260811120000_github_ingested_assets.sql`:

```sql
-- Ledger of GitHub-native user-attachments mirrored into workspaces
-- (spec docs/superpowers/specs/2026-08-11-github-attachment-ingestion-design.md).
-- One row per (repo, asset); detached_at NULL == currently referenced.
CREATE TABLE github_ingested_assets (
  repo        TEXT NOT NULL,
  asset_id    TEXT NOT NULL,
  workspace   TEXT NOT NULL,
  object_key  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  num         INTEGER NOT NULL,
  source      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  detached_at TEXT,
  PRIMARY KEY (repo, asset_id)
);
CREATE INDEX github_ingested_assets_source_idx ON github_ingested_assets (repo, source);
```

- [ ] **Step 2: Write the failing real-SQL test**

`apps/api/test/github-ingest-ledger-sqlite.test.ts`, modeled on `github-repo-links-sqlite.test.ts` (`SqliteD1` from `test/helpers/sqlite-d1.ts`, constructed with `["migrations/20260811120000_github_ingested_assets.sql"]`):

```ts
import { describe, expect, it } from "vitest";
import {
  ledgerRow,
  ledgerRowsForSource,
  recordIngestedAsset,
  setLedgerDetached,
  setLedgerSource,
} from "../src/github-ingest-ledger";
import { SqliteD1 } from "./helpers/sqlite-d1";

const row = (over: Partial<Parameters<typeof recordIngestedAsset>[1]> = {}) => ({
  repo: "acme/app",
  assetId: "assets/aaaa-bbbb",
  workspace: "acme",
  objectKey: "gh/acme-app/pull-7/aaaa-bbbb.png",
  kind: "pull" as const,
  num: 7,
  source: "body",
  createdAt: "2026-08-11T00:00:00.000Z",
  ...over,
});

describe("github ingest ledger", () => {
  it("records, reads back, and scopes by source", async () => {
    const db = new SqliteD1(["migrations/20260811120000_github_ingested_assets.sql"]);
    await recordIngestedAsset(db.d1, row());
    await recordIngestedAsset(db.d1, row({ assetId: "files/9/x.png", source: "comment:44" }));
    expect((await ledgerRow(db.d1, "acme/app", "assets/aaaa-bbbb"))?.objectKey).toBe(
      "gh/acme-app/pull-7/aaaa-bbbb.png",
    );
    expect(await ledgerRowsForSource(db.d1, "acme/app", "body")).toHaveLength(1);
  });

  it("detach and re-attach flip detached_at; duplicate record is ignored", async () => {
    const db = new SqliteD1(["migrations/20260811120000_github_ingested_assets.sql"]);
    await recordIngestedAsset(db.d1, row());
    await recordIngestedAsset(db.d1, row({ objectKey: "gh/other.png" })); // INSERT OR IGNORE
    expect((await ledgerRow(db.d1, "acme/app", "assets/aaaa-bbbb"))?.objectKey).toBe(
      "gh/acme-app/pull-7/aaaa-bbbb.png",
    );
    await setLedgerDetached(db.d1, "acme/app", "assets/aaaa-bbbb", "2026-08-12T00:00:00.000Z");
    expect((await ledgerRow(db.d1, "acme/app", "assets/aaaa-bbbb"))?.detachedAt).not.toBeNull();
    await setLedgerDetached(db.d1, "acme/app", "assets/aaaa-bbbb", null);
    expect((await ledgerRow(db.d1, "acme/app", "assets/aaaa-bbbb"))?.detachedAt).toBeNull();
  });

  it("setLedgerSource moves an asset between sources", async () => {
    const db = new SqliteD1(["migrations/20260811120000_github_ingested_assets.sql"]);
    await recordIngestedAsset(db.d1, row());
    await setLedgerSource(db.d1, "acme/app", "assets/aaaa-bbbb", "comment:44");
    expect(await ledgerRowsForSource(db.d1, "acme/app", "body")).toHaveLength(0);
    expect(await ledgerRowsForSource(db.d1, "acme/app", "comment:44")).toHaveLength(1);
  });
});
```

(Check how `SqliteD1` exposes the `D1Database` — if the instance itself is the D1, drop `.d1`. Mirror the existing sqlite suites exactly.)

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run apps/api/test/github-ingest-ledger-sqlite.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the module**

`apps/api/src/github-ingest-ledger.ts`, following `github-repo-links.ts`'s style (repo lowercased on every call; module doc comment explaining the ledger's role):

```ts
export async function recordIngestedAsset(db, row): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO github_ingested_assets (repo, asset_id, workspace, object_key, kind, num, source, created_at, detached_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
    )
    .bind(
      row.repo.toLowerCase(),
      row.assetId,
      row.workspace,
      row.objectKey,
      row.kind,
      row.num,
      row.source,
      row.createdAt,
    )
    .run();
}
```

`ledgerRowsForSource` / `ledgerRow`: `SELECT` mapping snake_case → the interface (write a private `fromRow`). `setLedgerDetached`: `UPDATE github_ingested_assets SET detached_at = ? WHERE repo = ? AND asset_id = ?`. `setLedgerSource`: same shape for `source`. These are consumed inside the queue consumer where D1 failures must THROW (retry semantics) — so unlike `findRepoLink`, do **not** swallow errors.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run apps/api/test/github-ingest-ledger-sqlite.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the fake table for UsageFakeD1 suites**

`apps/api/test/helpers/fake-ingest-ledger-table.ts`, modeled directly on `fake-repo-links-table.ts` (`tryRun`/`tryAll` matching the exact SQL strings from Step 4, whitespace-normalized), and register it in `apps/api/test/usage-fake-d1.ts` the same way the repo-links table is registered. Add one smoke assertion to the ledger sqlite test? No — the fake gets exercised by Task 4's tests; here just make `pnpm vitest run apps/api/test/usage-fake-d1.test.ts` (if it exists) or the full `apps/api` suite still pass.

- [ ] **Step 7: Run the full api test suite**

Run: `pnpm --filter @uploads/api test`
Expected: PASS (no regressions).

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations apps/api/src/github-ingest-ledger.ts apps/api/test
git commit -m "feat(api): github_ingested_assets ledger table + module"
```

---

### Task 3: Attachment URL extraction (pure)

**Files:**

- Create: `apps/api/src/github-attachment-extract.ts`
- Create: `apps/api/src/github-attachment-extract.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces (Tasks 4 and 5 depend on these):

```ts
export interface ExtractedAttachment {
  id: string;
  url: string;
} // id = "assets/<uuid>" | "files/<n>/<name>"
export function extractUserAttachments(text: string): ExtractedAttachment[]; // deduped by id, document order
export function hasUserAttachmentUrl(text: string): boolean; // cheap substring gate for the pure extractor
export function attachmentKeyBasename(id: string): string; // "assets/ab-cd" -> "ab-cd"; "files/9/My Shot.png" -> "9-my-shot.png"
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
  attachmentKeyBasename,
  extractUserAttachments,
  hasUserAttachmentUrl,
} from "./github-attachment-extract";

describe("extractUserAttachments", () => {
  it("finds bare, markdown-image, html img and video forms", () => {
    const text = [
      "intro https://github.com/user-attachments/assets/0a1b2c3d-1111-2222-3333-444455556666",
      "![shot](https://github.com/user-attachments/assets/9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff)",
      '<img src="https://github.com/user-attachments/assets/12345678-0000-0000-0000-000000000000" width="400">',
      '<video src="https://github.com/user-attachments/assets/87654321-0000-0000-0000-000000000000"></video>',
      "[log](https://github.com/user-attachments/files/1234/build-log.txt)",
    ].join("\n");
    const ids = extractUserAttachments(text).map((a) => a.id);
    expect(ids).toEqual([
      "assets/0a1b2c3d-1111-2222-3333-444455556666",
      "assets/9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff",
      "assets/12345678-0000-0000-0000-000000000000",
      "assets/87654321-0000-0000-0000-000000000000",
      "files/1234/build-log.txt",
    ]);
  });

  it("dedupes repeated references and ignores other github urls", () => {
    const u = "https://github.com/user-attachments/assets/0a1b2c3d-1111-2222-3333-444455556666";
    const text = `${u} and again ![x](${u}) plus https://github.com/acme/app/pull/7`;
    expect(extractUserAttachments(text)).toHaveLength(1);
    expect(extractUserAttachments("plain text")).toEqual([]);
  });

  it("strips trailing markdown/html delimiters from captured urls", () => {
    const text =
      "(see https://github.com/user-attachments/assets/0a1b2c3d-1111-2222-3333-444455556666)";
    expect(extractUserAttachments(text)[0]?.id).toBe("assets/0a1b2c3d-1111-2222-3333-444455556666");
  });
});

describe("hasUserAttachmentUrl", () => {
  it("is a cheap substring gate", () => {
    expect(hasUserAttachmentUrl("x https://github.com/user-attachments/assets/a1b2 y")).toBe(true);
    expect(hasUserAttachmentUrl("no attachments here")).toBe(false);
  });
});

describe("attachmentKeyBasename", () => {
  it("flattens ids into safe key basenames", () => {
    expect(attachmentKeyBasename("assets/0a1b-2c3d")).toBe("0a1b-2c3d");
    expect(attachmentKeyBasename("files/9/My Shot (final).png")).toBe("9-my-shot-final.png");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/api/src/github-attachment-extract.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Pure extraction of github.com/user-attachments references from PR/issue
 * markdown. The asset id (path after /user-attachments/) is the stable
 * identity the ingest ledger keys on — GitHub keeps it constant across
 * renders/edits. No I/O; safe to call from extractWebhookEvent.
 */
const ATTACHMENT_RE =
  /https:\/\/github\.com\/user-attachments\/(assets\/[0-9a-fA-F-]{8,}|files\/\d+\/[^\s)"'<>\]]+)/g;

export interface ExtractedAttachment {
  id: string;
  url: string;
}

export function extractUserAttachments(text: string): ExtractedAttachment[] {
  const seen = new Set<string>();
  const out: ExtractedAttachment[] = [];
  for (const m of text.matchAll(ATTACHMENT_RE)) {
    const id = m[1].replace(/[.,;:]+$/, ""); // trailing prose punctuation
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, url: `https://github.com/user-attachments/${id}` });
  }
  return out;
}

export function hasUserAttachmentUrl(text: string): boolean {
  return text.includes("github.com/user-attachments/");
}

export function attachmentKeyBasename(id: string): string {
  const flat = id.replace(/^(assets|files)\//, "").replace(/\//g, "-");
  return flat
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/-+\./g, ".") // "final-.png" -> "final.png"
    .replace(/^[-.]+|-+$/g, "");
}
```

(If files-core's `sanitizeKeyBasename` already does what `attachmentKeyBasename`'s sanitize step does, delegate to it instead of re-rolling — check its behavior first.)

- [ ] **Step 4: Run to verify pass, then commit**

Run: `pnpm vitest run apps/api/src/github-attachment-extract.test.ts` — PASS.

```bash
git add apps/api/src/github-attachment-extract.ts apps/api/src/github-attachment-extract.test.ts
git commit -m "feat(api): user-attachments url extraction"
```

---

### Task 4: Reconcile core + fetch/store pipeline

**Files:**

- Create: `apps/api/src/github-ingest.ts`
- Create: `apps/api/src/github-ingest.test.ts`
- Modify: `apps/api/src/file-metadata.ts` (add `updateFileMetadataValue`)
- Modify: `apps/api/src/files-core.ts` only if `UploadSurface` is a closed union — add `"github"` to it (find the type; it may live in analytics-engine.ts)

**Interfaces:**

- Consumes: Task 2 ledger functions; Task 3 `extractUserAttachments`/`attachmentKeyBasename`; existing `putObject(env, ws, key, bytes, workspaceName, opts)`, `resolveUploadPolicy`, `detectContentType`, `maxBytesForContentType` (guards.ts), `githubAppConfig`/`installationForRepo`/`installationToken`/`githubHeaders`/`githubFetch` (github-app.ts), `findRepoLinkStrict` (github-repo-links.ts), `loadWorkspaceRecord` (workspace.ts), `resolveRepoCommentOptions` (repo-comment-config.ts, Task 1 knob), `getFileMetadata` (file-metadata.ts).
- Produces (Tasks 5–6 depend on these exact signatures):

```ts
export interface IngestSourceRef {
  repo: string;
  kind: "pull" | "issues";
  num: number;
  source: string;
}
export interface IngestSummary {
  ingested: string[]; // object keys written
  reattached: string[]; // object keys un-detached
  detached: string[]; // object keys detached
  skipped: { url: string; reason: string }[];
}
export interface IngestDeps {
  fetchImpl?: typeof fetch;
  putImpl?: typeof putObject;
  now?: () => Date;
}

/** Reconcile ONE source (a body or one comment) against `text` (null = source gone: detach all). */
export async function reconcileIngestSource(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  ref: IngestSourceRef,
  text: string | null,
  author: string | null,
  deps?: IngestDeps,
): Promise<IngestSummary>;

/** Webhook entry: link lookup + knob gate + fetch current text + reconcile. Throws on transient failure. */
export async function ingestForWebhook(
  env: Env,
  ref: IngestSourceRef,
  deps?: IngestDeps,
): Promise<void>;

/** Manual entry: reconcile the body + every issue comment (paginated). */
export async function reconcileIngestTarget(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  target: { repo: string; kind: "pull" | "issues"; num: number },
  deps?: IngestDeps,
): Promise<IngestSummary>;
```

- [ ] **Step 1: Add the single-key metadata update helper (test first)**

In the existing file-metadata test suite add:

```ts
it("updateFileMetadataValue flips one key without touching others", async () => {
  // seed via replaceFileMetadata: { "gh.detached": "false", "path": "/x" } plus a
  // server video.* row via setServerFileMetadata, then:
  await updateFileMetadataValue(db, "ws", "k.png", "gh.detached", "true");
  // assert gh.detached === "true", path untouched, video.* row untouched.
});
```

Implement in `apps/api/src/file-metadata.ts`:

```ts
/**
 * Targeted single-key value update. Exists because replaceFileMetadata is
 * delete-then-insert over the whole key set and would wipe server-owned
 * video.* rows — never use replace to flip one flag.
 */
export async function updateFileMetadataValue(
  db: D1Database,
  workspace: string,
  objectKey: string,
  metaKey: string,
  value: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE file_metadata SET meta_value = ?, updated_at = ? WHERE workspace = ? AND object_key = ? AND meta_key = ?",
    )
    .bind(value, new Date().toISOString(), workspace, objectKey, metaKey)
    .run();
}
```

Run the file-metadata suite (both the sqlite and fake variants if both cover it): PASS. Check whether `fake-file-metadata-table.ts` needs a `tryRun` branch for this UPDATE shape — add it.

- [ ] **Step 2: Write the failing reconcile tests**

`apps/api/src/github-ingest.test.ts`. Harness: `UsageFakeD1` (now with the ledger fake from Task 2) as `env.DB`, `FakeKv` as `GITHUB_CACHE`, `GITHUB_APP_CFG_ENV` spread into env, a `fetchImpl` fake in the `repo-comment-config.test.ts` style (routes for installation, token, issue GET, comment GET, and the asset URLs returning PNG magic bytes `new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...])` with `content-type: image/png`), and a `putImpl` spy that records calls and returns `{ key, size, contentType: "image/png", replaced: false, url: null, embedUrl: null }`. `ws` is a minimal `{} as WorkspaceRecord` (plus plan-limit fields where a test needs them).

Cover, one `it` each:

1. **New asset in body → put + ledger row + metadata stamped.** `reconcileIngestSource` with text containing one asset URL. Assert: `putImpl` called once with key `gh/acme-app/pull-7/<uuid>.png` and `opts.metadata` equal to `{ "gh.repo": "acme/app", "gh.kind": "pull", "gh.number": "7", "gh.origin": "github", "gh.author": "octocat", "gh.detached": "false", "gh.source": "body" }` and `opts.surface: "github"`; summary `ingested` has the key; ledger row exists non-detached.
2. **Already-ledgered asset → no re-fetch, no put.** Seed ledger; same text. Assert `putImpl` not called, summary all-empty.
3. **Removal → detach.** Seed ledger (attached) + seed file metadata `gh.detached=false`; text without the URL. Assert ledger `detachedAt` set, `file_metadata` row now `"true"`, summary `detached` has the key.
4. **Re-add → re-attach without re-fetch.** Seed detached ledger row; text with the URL. Assert `putImpl` not called, `detachedAt` null again, metadata `"false"`, summary `reattached`.
5. **`text: null` (comment deleted) → detach all rows of that source only.** Two ledger rows, different sources; assert only the matching source's row detached.
6. **Guard skip is permanent.** Asset route returns `content-type: text/html` + HTML bytes → `detectContentType` yields non-media → summary `skipped` with `reason: "unsupported_media_type"`, no put, no ledger row, **no throw**. Same for an asset route returning 404 → `reason: "asset_not_found"`.
7. **Oversize skip.** Asset bytes longer than `maxBytesForContentType` for the sniffed type → `skipped` `reason: "too_large"`, no put.
8. **Budget/put failure skip.** `putImpl` throws an error with `.code === "storage_quota_exceeded"` (build via the repo's error class) → `skipped` `reason: "storage_quota_exceeded"`; a plain `new Error("boom")` from `putImpl` → **rethrown** (transient).
9. **Transient asset fetch → throws.** Asset route returns 503 → `reconcileIngestSource` rejects.
10. **`ingestForWebhook` gates.** (a) no repo link → resolves, no fetches; (b) link + workspace but knob false (no `.uploads.yml`, ws default unset) → resolves, no asset fetches; (c) knob true via ws record `githubIngestAttachments: true` → fetches issue body (route `/repos/acme/app/issues/7` returns `{ body: "<url>", user: { login: "octocat" } }`), puts, ledgers. (d) comment source fetches `/repos/acme/app/issues/comments/44`; a 404 there → reconcile with `text: null` (detach-all for that source), not a throw.
11. **`reconcileIngestTarget` walks body + comments.** Comments route returns two pages (`per_page=100`, page 2 shorter); assert one reconcile per comment + one for body; summary is the merged totals.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run apps/api/src/github-ingest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `apps/api/src/github-ingest.ts`**

Skeleton (follow the file-doc-comment style of github-webhook.ts; key logic):

```ts
const SKIP_CODES = new Set([
  "storage_quota_exceeded",
  "upload_budget_exceeded",
  "unsupported_media_type",
  "file_metadata_limit_exceeded",
  "empty_body",
]);
const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

function ingestKey(ref: IngestSourceRef, assetId: string, ext: string): string {
  const repoSeg = ref.repo.toLowerCase().replace("/", "-");
  return `gh/${repoSeg}/${ref.kind}-${ref.num}/${attachmentKeyBasename(assetId)}.${ext}`;
}

function ingestMetadata(ref: IngestSourceRef, author: string | null): Record<string, string> {
  return {
    "gh.repo": ref.repo.toLowerCase(),
    "gh.kind": ref.kind,
    "gh.number": String(ref.num),
    "gh.origin": "github",
    ...(author ? { "gh.author": author } : {}),
    "gh.detached": "false",
    "gh.source": ref.source,
  };
}
```

`reconcileIngestSource` flow:

1. `const found = text === null ? [] : extractUserAttachments(text);`
2. For each found attachment: `ledgerRow(db, ref.repo, id)`:
   - row exists, `detachedAt === null` → nothing (but if `row.source !== ref.source`, call `setLedgerSource` — the image moved between sources).
   - row exists, detached → `setLedgerDetached(db, repo, id, null)` + `updateFileMetadataValue(db, workspaceName, row.objectKey, "gh.detached", "false")` → `reattached`.
   - no row → **fetch & store** (below) → `recordIngestedAsset` → `ingested`.
3. `ledgerRowsForSource(db, ref.repo, ref.source)`: every non-detached row whose `assetId` is not in the found set → `setLedgerDetached(..., now)` + `updateFileMetadataValue(..., "gh.detached", "true")` → `detached`.

Fetch & store (private `fetchAndStore`):

1. Installation token: `githubAppConfig(env)` → null? push skip `app_not_configured`. `installationForRepo` → null? skip `app_not_installed`. `installationToken` → null? **throw** (transient — token mint outages should retry).
2. `const res = await githubFetch(fetchImpl, url, { headers: { authorization: `Bearer ${token}`, "user-agent": "uploads.sh" } });` — 404/403/410 → skip `asset_not_found`; other non-ok → throw; ok → `new Uint8Array(await res.arrayBuffer())`.
3. `const sniffed = detectContentType(bytes);` null or not in `EXT_BY_TYPE` → skip `unsupported_media_type`.
4. `const policy = resolveUploadPolicy(ws);` `bytes.length > maxBytesForContentType(policy, sniffed)` → skip `too_large` (cheap pre-check so we don't hand 100 MB to putObject; putObject re-enforces).
5. `putImpl(env, ws, ingestKey(ref, id, EXT_BY_TYPE[sniffed]), bytes, workspaceName, { metadata: ingestMetadata(ref, author), replace: true, surface: "github" })` — catch: error with `code` in `SKIP_CODES` → skip with that code as reason; anything else → rethrow.

`ingestForWebhook`: `findRepoLinkStrict` (throws on D1 outage — desired) → null? return. `loadWorkspaceRecord` → null? return. `resolveRepoCommentOptions(env, ws, ref.repo)` → `!options.ingestGithubAttachments`? return. Fetch text+author: source `"body"` → `GET https://api.github.com/repos/${ref.repo}/issues/${ref.num}` (the issues API serves PR bodies too); source `comment:<id>` → `GET .../issues/comments/<id>`; both with `githubHeaders(token)` via `githubFetch`; 404 → `text = null`; non-ok non-404 → throw. Then `reconcileIngestSource`.

`reconcileIngestTarget`: fetch the body (as above, author from `.user.login`), then `GET .../issues/${num}/comments?per_page=100&page=N` for N = 1..3 (stop early on a short page); reconcile `"body"` then `comment:<id>` per comment (comment author from each comment's `.user.login`); merge summaries. Log a structured line if page 3 was full (`{ message: "github ingest comment scan truncated", repo, num }`) — no silent caps.

If `UploadSurface` is a closed union that rejects `"github"`, add `"github"` to it where it's defined.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run apps/api/src/github-ingest.test.ts`
Expected: PASS. Then `pnpm --filter @uploads/api test` — no regressions.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): github attachment ingest reconcile core"
```

---

### Task 5: Webhook wiring

**Files:**

- Modify: `apps/api/src/github-webhook.ts` (`WebhookEvent`, `extractWebhookEvent`, `processWebhookEvent`)
- Modify: `apps/api/src/github-webhook.test.ts` / `apps/api/src/github-webhook-queue.test.ts` (whichever covers `extractWebhookEvent` — extend it)

**Interfaces:**

- Consumes: Task 3 `hasUserAttachmentUrl`; Task 4 `ingestForWebhook` + `IngestSourceRef`.
- Produces: `WebhookEvent.ingest?: IngestSourceRef` — consumed transparently by the existing queue consumer.

- [ ] **Step 1: Write the failing extractor tests**

In the suite that already unit-tests `extractWebhookEvent`, add cases (payload shapes mirror the existing tests):

```ts
const URL = "https://github.com/user-attachments/assets/0a1b2c3d-1111-2222-3333-444455556666";

it("pull_request opened with attachment url sets ingest", () => {
  const ev = extractWebhookEvent("pull_request", {
    action: "opened",
    repository: { full_name: "acme/app" },
    pull_request: { number: 7, body: `hello ${URL}` },
  });
  expect(ev?.ingest).toEqual({ repo: "acme/app", kind: "pull", num: 7, source: "body" });
});

it("pull_request opened without attachment url sets no ingest", () => {
  /* body: "hi" → ev?.ingest undefined */
});

it("issues edited with a body change always sets ingest (removal case)", () => {
  const ev = extractWebhookEvent("issues", {
    action: "edited",
    changes: { body: { from: "old" } },
    repository: { full_name: "acme/app" },
    issue: { number: 3, body: "no urls anymore" },
  });
  expect(ev?.ingest).toEqual({ repo: "acme/app", kind: "issues", num: 3, source: "body" });
});

it("issues edited title-only (no changes.body) sets no ingest", () => {
  /* changes: { title: {...} } */
});

it("issue_comment created with url sets ingest with comment source", () => {
  const ev = extractWebhookEvent("issue_comment", {
    action: "created",
    repository: { full_name: "acme/app" },
    issue: { number: 7, pull_request: {} },
    comment: { id: 44, body: URL, user: { login: "octocat", type: "User" } },
  });
  expect(ev?.ingest).toEqual({ repo: "acme/app", kind: "pull", num: 7, source: "comment:44" });
});

it("issue_comment created without url sets no ingest", () => {
  /* stays null overall if no other work */
});

it("issue_comment edited always sets ingest; deleted sets ingest only when the removed body had a url", () => {
  /* edited: no url in body → still ingest. deleted with url body → ingest; deleted plain-text body → none */
});
```

Also extend the queue-consumer test: a message whose body is `{ keys: [], ingest: {...} }` must invoke ingest processing (spy via module mock of `github-ingest`) and ack; an `ingestForWebhook` throw must `retry()`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/api/src/github-webhook.test.ts apps/api/src/github-webhook-queue.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `github-webhook.ts`:

```ts
export interface WebhookEvent {
  keys: string[];
  promote?: { repo: string; num: number; branch: string };
  reconcile?: { repo: string; num: number; kind: GhTarget["kind"] };
  /** Opt-in GitHub-native attachment ingest (spec 2026-08-11). Source ref only —
   * the consumer re-fetches current text, so this stays queue-compact. */
  ingest?: IngestSourceRef;
}
```

Gating in `extractWebhookEvent` (all pure, payload-only — mirror the existing defensive typeof style):

- `issues` / `pull_request`, `action === "opened"`: set `ingest` iff `hasUserAttachmentUrl(body)`.
- `issues` / `pull_request`, `action === "edited"`: set `ingest` iff the payload's `changes.body` exists (a body edit — covers both add and remove; title-only edits skip).
- `issue_comment created`: iff `hasUserAttachmentUrl(comment.body)`. `source: \`comment:${comment.id}\``.
- `issue_comment edited`: always (removal is invisible in the new body). Skip when `sender.type === "Bot"` — our own writes and other bots' churn.
- `issue_comment deleted`: iff `hasUserAttachmentUrl(comment.body)` (payload carries the pre-deletion body). The consumer's comment GET will 404 → detach-all.
- `kind` from `issue.pull_request ? "pull" : "issues"` (comments) / the event type (bodies). Repo lowercased? **No** — keep the exact `full_name` casing like `promote` does; the ledger lowercases internally.
- Keep the final `return ev.keys.length || ev.promote || ev.reconcile || ev.ingest ? ev : null;`

In `processWebhookEvent`, after the reconcile branch:

```ts
if (ev.ingest) {
  await ingestForWebhook(env, ev.ingest);
}
```

(Import from `./github-ingest`.) Update the retry-path log fields in `handleGithubWebhookBatch` / `processInline` to include `ingest: ev.ingest ?? null`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run apps/api/src/github-webhook.test.ts apps/api/src/github-webhook-queue.test.ts`, then `pnpm --filter @uploads/api test`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): webhook-driven github attachment ingest (opt-in)"
```

---

### Task 6: Manual ingest endpoint

**Files:**

- Modify: `apps/api/src/routes/workspace-github.ts`
- Test: the existing `apps/api/test/routes-workspace-github.test.ts` (or the file that covers the other `/v1/workspaces/:workspace/github/*` routes — extend it)

**Interfaces:**

- Consumes: Task 4 `reconcileIngestTarget`; existing `dualWorkspaceAuth`, `requireScope`-via-`scoped("files:write")`, `writeRateLimit`-via-`rateLimited`, `findRepoLink` + `deriveRepoBinding` (github-repo-links.ts), `loadWorkspaceRecord`.
- Produces: `POST /v1/workspaces/:workspace/github/ingest`, JSON body `{ repo: string, pr?: number, issue?: number }` → 200 `{ repo, kind, num, ingested: string[], reattached: string[], detached: string[], skipped: {url, reason}[] }`. Task 7's CLI calls this.

- [ ] **Step 1: Write the failing route tests**

In the workspace-github route suite (reuse its app-builder + `UsageFakeD1` + fake-fetch setup):

1. Token auth + linked repo + one asset in body → 200 with `ingested` length 1 (stub the GitHub routes as in Task 4's test; module-mock `github-ingest` only if the suite can't carry the full fake — prefer the real core with fakes).
2. `pr` and `issue` both set → 400 `ValidationError` code `github_ingest_target`; neither set → same.
3. Repo not linked to this workspace (no link, or linked elsewhere) → 404 (use `deriveRepoBinding` — must not leak the owning workspace's name in the "other" case).
4. Works with the ingest knob **off** (manual bypasses it — assert with a ws record lacking `githubIngestAttachments`).
5. Session (cookie) auth path also allowed (dualWorkspaceAuth default) — one smoke case.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/api/test/routes-workspace-github.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the handler + route**

In `workspace-github.ts` (new-endpoint-only, so the handler lives here rather than in a legacy router):

```ts
const githubIngestHandler: Handler<DualAuthVars> = async (c) => {
  const ws = c.get("workspace");
  const workspaceName = c.get("workspaceName");
  const body = await c.req.json().catch(() => ({}));
  const repo = typeof body.repo === "string" ? body.repo : "";
  const pr = typeof body.pr === "number" ? body.pr : undefined;
  const issue = typeof body.issue === "number" ? body.issue : undefined;
  if (!REPO_RE.test(repo) || (pr === undefined) === (issue === undefined)) {
    throw new ValidationError("repo plus exactly one of pr or issue required", {
      code: "github_ingest_target",
    });
  }
  const link = await findRepoLink(c.env.DB, repo);
  if (deriveRepoBinding(link, workspaceName) !== "self") {
    // 404 (not 403) so "other" can't confirm the repo is claimed elsewhere.
    throw new NotFoundError("repo is not linked to this workspace", { code: "repo_not_linked" });
  }
  const target = {
    repo,
    kind: pr !== undefined ? ("pull" as const) : ("issues" as const),
    num: (pr ?? issue) as number,
  };
  const summary = await reconcileIngestTarget(c.env, ws, workspaceName, target);
  return c.json({ repo: repo.toLowerCase(), kind: target.kind, num: target.num, ...summary });
};
```

(Reuse/import `REPO_RE` from github-app.ts if exported; otherwise inline the same pattern. Use the repo's actual error classes from `error-response.ts`.) Register:

```ts
.post("/:workspace/github/ingest", dualWorkspaceAuth(), rateLimited, scoped("files:write"), githubIngestHandler)
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run apps/api/test/routes-workspace-github.test.ts`, then `pnpm --filter @uploads/api test` and `pnpm --filter @uploads/api types`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): manual github attachment ingest endpoint"
```

---

### Task 7: CLI `uploads ingest`

**Files:**

- Modify: `packages/uploads/src/client.ts` (new client method)
- Modify: `packages/uploads/src/commands.ts` (`runIngest` + `INGEST_HELP`)
- Modify: `packages/uploads/src/cli.ts` (dispatch case)
- Modify: `packages/uploads/src/cli-catalog.ts` (help + did-you-mean entry)
- Test: `packages/uploads/test/commands-ingest.test.ts` (new, modeled on an existing `commands-*.test.ts` that fakes the API)
- Modify: the CLI reference docs — find with `grep -rn "uploads usage" docs apps/web/src/pages/docs` and add an `ingest` section beside it; also the in-repo `uploads-cli` skill reference if it lists commands (`grep -rn "gallery" skills/` to locate)
- Create: `.changeset/<generated>.md` (minor bump, published CLI package only)

**Interfaces:**

- Consumes: Task 6's endpoint contract; existing `CliContext`, `parseCommandArgs`, `flagInt`, `flagString`, `ghTargetFromFlags` (commands.ts), `writeJson`/`writeStdout` (io.ts), `UsageError`.
- Produces: `uploads ingest --pr <n> | --issue <n> [--repo owner/name] [--workspace ws]`; JSON mode emits the endpoint response verbatim.

- [ ] **Step 1: Write the failing command test**

Model on an existing small-command test (find one that stubs the client, e.g. the usage or comment command test). Cases:

1. `runIngest(ctx, ["--pr", "7"])` calls `client.ingestGithub({ repo: "<derived>", kind: "pull", num: 7 })` and prints a human summary line per bucket (`Ingested 2, re-attached 0, detached 1, skipped 0`), exit 0. Derive repo through the same `ghTargetFromFlags` path other commands use (stub the git runner).
2. `--pr` and `--issue` together → `UsageError` (comes free from `makeGhTarget`).
3. Neither `--pr` nor `--issue` and no auto-resolvable PR → `UsageError("--pr or --issue required")`.
4. `ctx.json` true → `writeJson` with the raw response.
5. Skipped entries render as `skipped: <url> (<reason>)` lines in human mode.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/uploads/test/commands-ingest.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Client method in `client.ts` (copy the shape of an existing POST-JSON method — e.g. the comment or gallery-create method — same auth header + error mapping):

```ts
async ingestGithub(input: { repo: string; kind: "pull" | "issues"; num: number }): Promise<IngestGithubResult> {
  const body = input.kind === "pull"
    ? { repo: input.repo, pr: input.num }
    : { repo: input.repo, issue: input.num };
  return this.postJson(`/v1/workspaces/${encodeURIComponent(this.workspace)}/github/ingest`, body);
}
```

(`postJson` = whatever the surrounding methods actually use; match it exactly. Define `IngestGithubResult` mirroring the Task 6 response.)

`runIngest` in `commands.ts`, following `runUsage`'s exact shape: help gate → `ghTargetFromFlags(parseCommandArgs(args).flags, run)` (throws on the mutually-exclusive case; `UsageError("--pr or --issue required")` when undefined) → `ctx.client.ingestGithub(target)` → `writeJson` or human lines. `INGEST_HELP` template with an `Examples:` block:

```
uploads ingest — mirror GitHub-native attachments from a PR/issue into the workspace

Usage:
  uploads ingest --pr <n> [--repo owner/name]
  uploads ingest --issue <n> [--repo owner/name]

Scans the PR/issue description and comments for github.com/user-attachments
media, mirrors new ones into the workspace (indexed, not added to the managed
comment), and detaches ones no longer referenced. Works on any repo linked to
the workspace; the .uploads.yml ingestGithubAttachments knob only gates the
automatic webhook path.

Examples:
  uploads ingest --pr 123
  uploads ingest --issue 45 --repo acme/app --format json
```

Register in `cli.ts` (`case "ingest":` following the `usage` case's `createContext` pattern) and add the catalog entry in `cli-catalog.ts`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/uploads/test/commands-ingest.test.ts` then the package suite `pnpm --filter uploads test` (use the actual package name from `packages/uploads/package.json`).
Expected: PASS.

- [ ] **Step 5: Docs + changeset**

- Add the `ingest` command to the CLI reference page found via the grep above (match the surrounding sections' voice; plain declaratives, no marketing).
- If `skills/` contains the `uploads-cli` reference skill with a command list, add `ingest` there with the same one-paragraph contract.
- `pnpm changeset` → minor, ONLY the published CLI package (`uploads`); message: `Add \`uploads ingest\` to mirror GitHub-native PR/issue attachments into the workspace.`

- [ ] **Step 6: Commit**

```bash
git add packages/uploads .changeset docs apps/web skills 2>/dev/null; git add -A packages/uploads .changeset
git commit -m "feat(cli): uploads ingest command"
```

---

### Task 8: Screenshots page "From GitHub" section

**Files:**

- Modify: `apps/web/src/components/ScreenshotsByPath.tsx`
- Modify: `apps/web/src/lib/api-client.ts` only if a new fetch wrapper is needed (it is not — `searchWorkspaceFiles` already takes arbitrary meta filters)
- Test: the existing ScreenshotsByPath/web test if one exists (`ls apps/web/src/components/*.test.*`); otherwise verify by typecheck + browser

**Interfaces:**

- Consumes: `searchWorkspaceFiles(apiOrigin, workspace, filters)` with `[{ key: "gh.origin", value: "github" }, { key: "gh.detached", value: "false" }]`; `SearchFileItem`; Task 4's metadata contract.
- Produces: a "From GitHub" section on `/account/workspaces/:name/screenshots` listing non-detached mirrored assets, grouped visually below the by-path groups.

- [ ] **Step 1: Implement the section**

In `ScreenshotsByPath.tsx`, alongside the existing overview fetch, add a second parallel fetch:

```ts
const [ghState, setGhState] = useState<DrillState>({ status: "idle" });
// in the same effect that loads the overview:
searchWorkspaceFiles(apiOrigin, workspace, [
  { key: "gh.origin", value: "github" },
  { key: "gh.detached", value: "false" },
]).then(/* map to DrillState exactly like the drill-in path does */);
```

Render below the by-path groups, only when non-empty (no empty-state block — absence is the norm), reusing the exact thumbnail/list markup the drill-in view uses (`shotKindFromKey` for image/video), with a section heading "From GitHub" and each item labeled by `metadata["gh.kind"]`+`metadata["gh.number"]` (e.g. `PR #7`) and `metadata["gh.author"]` when present. Follow the existing loading/error state handling; an error in this fetch must not break the by-path view (render nothing).

- [ ] **Step 2: Typecheck + tests**

Run: `pnpm --filter @uploads/web types` (note: this runs `wrangler types`, not a full typecheck — also run the web test/`astro check` command used in CI, found in `apps/web/package.json` scripts) and any component tests found in Step 0.
Expected: PASS.

- [ ] **Step 3: Browser verification**

Serve via the local stack recipe (stack-raw on 127.0.0.1 for a signed-in session), seed one file with the Task 4 metadata via the API, and confirm the section renders; screenshot for the PR.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): From GitHub section on the screenshots page"
```

---

### Task 9: Integration verification + PR

- [ ] **Step 1: Full-suite run**

Run: `pnpm test` (root unified runner) and `pnpm --filter @uploads/api types && pnpm --filter @uploads/web types`. Also the repo's typecheck script if separate (`pnpm types` is NOT typecheck — check root package.json for the real one, e.g. `pnpm typecheck` or per-package `tsc`).
Expected: all PASS.

- [ ] **Step 2: End-to-end smoke against local fakes**

One new test OR a scripted run proving the full chain: webhook delivery JSON (issue_comment created with an asset URL) → `handleWebhook` → queue message → `handleGithubWebhookBatch` → object written with correct key/metadata → `findObjectsByMetadata` returns it for `{ "gh.origin": "github", "gh.detached": "false" }`. If Task 5's consumer test already covers this end-to-end with the real reconcile core, point at it and skip.

- [ ] **Step 3: Open the PR**

Branch from this worktree, push, `gh pr create --body-file` with: summary, spec/plan links, the opt-in story (knob default off; manual path always available), the detach semantics, and the Task 8 screenshot embedded via the `github-screenshots` skill. Note in the PR body that the D1 migration auto-applies on merge. Do not request a CodeRabbit review by default.
