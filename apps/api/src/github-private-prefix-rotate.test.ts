/**
 * Service-level coverage for `rotatePrivatePrefix` (issue #631, Task 8) —
 * mint a fresh id, move every object under the old id, rename the D1 rows
 * that point at those object keys, retire the old row, and re-sync the
 * managed comment for every PR/issue that had a moved object. Route
 * coverage (403 unauthorized, 200 shape) lives in
 * `routes/github-private-prefix-rotate.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { attachmentRow, recordAttachment } from "./github-attachment-index";
import { getFileMetadata } from "./file-metadata";
import { putObject } from "./files-core";
import {
  ghPrivateAttachmentKey,
  ghPrivateBranchAttachmentKey,
  GH_PRIVATE_ROOT,
} from "./github-comment-render";
import { attachmentsMarker } from "./github-comment-render";
import { rotatePrivatePrefix } from "./github-private-prefix-service";
import { getActivePrefixId, getOrMintPrefixId, retirePrefixId } from "./github-private-prefixes";
import { ledgerRow, recordIngestedAsset } from "./github-ingest-ledger";
import { recordRepoLink } from "./github-repo-links";
import { getWorkspaceUsage } from "./usage";
import { sha256Hex, type WorkspaceRecord } from "./workspace";
import { FakeKv } from "../test/fake-kv";
import { FakeR2Bucket } from "../test/fake-r2";
import { GITHUB_APP_CFG_ENV } from "../test/github-app-env";
import { SqliteD1, database } from "../test/helpers/sqlite-d1";

const MIGRATIONS = [
  "migrations/20260710140000_workspace_usage.sql",
  "migrations/20260822120100_workspace_usage_shared_subset.sql",
  "migrations/20260711180000_galleries.sql",
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20260720120000_github_repo_links.sql",
  "migrations/20260721150000_github_pr_activity.sql",
  "migrations/20260724140000_file_content_hash.sql",
  "migrations/20260728120000_daily_metrics.sql",
  "migrations/20260730170533_delete_usage_claims.sql",
  "migrations/20260811120000_github_ingested_assets.sql",
  "migrations/20260811210000_github_private_prefixes.sql",
  "migrations/20260903120000_github_attachments.sql",
];

const WS = "acme";
const PREFIX = "acme/";
const REPO = "acme/web";
const BRANCH = "feat-x";
const NUM = 7;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function seededEnv(opts: { linked?: boolean } = {}) {
  const sqlite = new SqliteD1(MIGRATIONS, ["PRAGMA foreign_keys = ON"]);
  const db = database(sqlite);
  const bucket = new FakeR2Bucket();
  const kv = new FakeKv();
  kv.store.set(`ghinst:${REPO}`, { value: "42" });
  kv.store.set(`ghtok:42`, { value: "cached-token" });
  const ws: WorkspaceRecord = {
    provider: "r2",
    bucket: "b",
    binding: "UPLOADS_DEFAULT",
    prefix: PREFIX,
    publicBaseUrl: "https://storage.uploads.sh",
    tokens: [{ hash: await sha256Hex("unused"), createdAt: new Date().toISOString() }],
  };
  const env = {
    DB: db,
    UPLOADS_DEFAULT: bucket,
    GITHUB_CACHE: kv,
    ...GITHUB_APP_CFG_ENV,
  } as unknown as Env;
  if (opts.linked !== false) await recordRepoLink(db, REPO, WS, "test");
  return { env, db, bucket, ws };
}

/** Marker comment already exists on the PR thread — patchable via PATCH. */
function commentFlowFetch(seen: { bodies: string[] }) {
  return (async (url: string, init: RequestInit = {}) => {
    if (String(url).includes(`/issues/${NUM}/comments`) && init.method !== "POST") {
      return new Response(JSON.stringify([{ id: 99, body: `${attachmentsMarker(WS)}\nold` }]), {
        status: 200,
      });
    }
    if (String(url).includes("/issues/comments/99")) {
      if (init.body) seen.bodies.push(String(init.body));
      return new Response(
        JSON.stringify({ id: 99, html_url: "https://github.com/acme/web/pull/7#c99" }),
        { status: 200 },
      );
    }
    return new Response("nf", { status: 404 });
  }) as unknown as typeof fetch;
}

function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = real;
  });
}

describe("rotatePrivatePrefix", () => {
  it("mints a new id, moves every object + D1 row, retires the old id, and resyncs the comment once per (kind,num)", async () => {
    const { env, db, bucket, ws } = await seededEnv();
    const oldId = await getOrMintPrefixId(db, REPO, BRANCH);

    const pullKey = ghPrivateAttachmentKey(oldId, { repo: REPO, kind: "pull", num: NUM }, "a.png");
    const branchKey = ghPrivateBranchAttachmentKey(oldId, "b.png");

    // Seeded through `putObject` (not a raw `bucket.put`) so the usage
    // ledger starts credited for these objects, the same as any real
    // attachment — otherwise the usage assertion below couldn't tell a
    // correctly-netted rotation apart from a `deleteObject` call that never
    // ran at all.
    await putObject(env, ws, pullKey, PNG, WS, {
      metadata: { "gh.repo": REPO, "gh.kind": "pull", "gh.number": String(NUM) },
    });
    await putObject(env, ws, branchKey, PNG, WS, {
      metadata: { "gh.repo": REPO, "gh.kind": "branch", "gh.branch": BRANCH },
    });
    await recordIngestedAsset(db, {
      repo: REPO,
      assetId: "assets/uuid-1",
      workspace: WS,
      objectKey: pullKey,
      kind: "pull",
      num: NUM,
      source: "body",
      createdAt: new Date().toISOString(),
    });

    const seen = { bodies: [] as string[] };
    const result = await withFetch(commentFlowFetch(seen), () =>
      rotatePrivatePrefix(env, ws, WS, "user-1", REPO, BRANCH),
    );

    expect(result.rotated).toBe(true);
    if (!result.rotated) throw new Error("expected rotated: true");
    expect(result.prefixId).not.toBe(oldId);
    expect(result.prefixId).toMatch(/^[0-9a-f]{32}$/);
    expect(result.moved).toBe(2);

    const newId = result.prefixId;
    const newPullKey = ghPrivateAttachmentKey(
      newId,
      { repo: REPO, kind: "pull", num: NUM },
      "a.png",
    );
    const newBranchKey = ghPrivateBranchAttachmentKey(newId, "b.png");

    // Objects exist at the new tails, old objects are gone.
    expect(bucket.store.has(`${PREFIX}${newPullKey}`)).toBe(true);
    expect(bucket.store.has(`${PREFIX}${newBranchKey}`)).toBe(true);
    expect(bucket.store.has(`${PREFIX}${pullKey}`)).toBe(false);
    expect(bucket.store.has(`${PREFIX}${branchKey}`)).toBe(false);

    // file_metadata follows the rename.
    const newPullMeta = await getFileMetadata(db, WS, newPullKey);
    expect(newPullMeta["gh.number"]).toBe(String(NUM));
    const oldPullMeta = await getFileMetadata(db, WS, pullKey);
    expect(oldPullMeta).toEqual({});

    // Ingested-asset ledger row follows the rename.
    const ledger = await ledgerRow(db, REPO, "assets/uuid-1");
    expect(ledger?.objectKey).toBe(newPullKey);

    // Old row is retired; the new row is the active one.
    const active = await getActivePrefixId(db, REPO, BRANCH);
    expect(active).toBe(newId);

    // Comment resync invoked exactly once for pull#7, embedding the new prefix.
    expect(seen.bodies).toHaveLength(1);
    expect(seen.bodies[0]).toContain(newId);
    expect(seen.bodies[0]).not.toContain(oldId);

    // Usage isn't double-counted: the move deletes the old key (via
    // `deleteObject`, which releases its ledger bytes/objects), so net
    // storage stays at "2 objects worth of bytes", not 4.
    const usage = await getWorkspaceUsage(db, WS);
    expect(usage.objects).toBe(2);
    expect(usage.bytes).toBe(PNG.byteLength * 2);
  });

  it("a stored text/plain object under an extension-less key keeps its content type across rotation", async () => {
    const { env, db, bucket, ws } = await seededEnv();
    const oldId = await getOrMintPrefixId(db, REPO, BRANCH);
    const notesKey = ghPrivateBranchAttachmentKey(oldId, "notes");
    const notes = new TextEncoder().encode("build log\nno errors\n");

    await putObject(env, ws, notesKey, notes, WS, {
      metadata: { "gh.repo": REPO, "gh.kind": "branch" },
      declaredContentType: "text/plain",
    });

    const result = await withFetch(commentFlowFetch({ bodies: [] }), () =>
      rotatePrivatePrefix(env, ws, WS, "user-1", REPO, BRANCH),
    );

    expect(result.rotated).toBe(true);
    if (!result.rotated) throw new Error("expected rotated: true");

    const newKey = ghPrivateBranchAttachmentKey(result.prefixId, "notes");
    const stored = bucket.store.get(`${PREFIX}${newKey}`);
    expect(stored).toBeDefined();
    expect(stored?.contentType).toBe("text/plain");
    expect([...(stored?.data ?? [])]).toEqual([...notes]);
  });

  it("review fix 1 (Critical): rotating an object carrying inheritable metadata (repo/path/url) doesn't throw a UNIQUE constraint violation — the new key ends up with exactly the old rows, once", async () => {
    const { env, db, ws } = await seededEnv();
    const oldId = await getOrMintPrefixId(db, REPO, BRANCH);
    const pullKey = ghPrivateAttachmentKey(
      oldId,
      { repo: REPO, kind: "pull", num: NUM },
      "shot.png",
    );

    // `repo`/`path`/`url` are in INHERITABLE_META_KEYS (content-hash.ts) —
    // this is the shape a real CLI screenshot stamps. Rotation's copy calls
    // `putObject` with no explicit `metadata`, which triggers ADDITIVE
    // content-hash inheritance: since the new key's bytes are identical to
    // this (still-present) old key, `putObject` finds the old key as its
    // own donor and writes these rows onto the new key BEFORE rotation's
    // own rename runs.
    await putObject(env, ws, pullKey, PNG, WS, {
      metadata: {
        "gh.repo": REPO,
        "gh.kind": "pull",
        "gh.number": String(NUM),
        repo: "acme/web",
        path: "/dashboard",
        url: "https://acme.test/dashboard",
      },
    });

    const result = await withFetch(commentFlowFetch({ bodies: [] }), () =>
      rotatePrivatePrefix(env, ws, WS, "user-1", REPO, BRANCH),
    );

    expect(result.rotated).toBe(true);
    if (!result.rotated) throw new Error("expected rotated: true");

    const newKey = ghPrivateAttachmentKey(
      result.prefixId,
      { repo: REPO, kind: "pull", num: NUM },
      "shot.png",
    );
    const meta = await getFileMetadata(db, WS, newKey);
    expect(meta).toEqual({
      "gh.repo": REPO,
      "gh.kind": "pull",
      "gh.number": String(NUM),
      repo: "acme/web",
      path: "/dashboard",
      url: "https://acme.test/dashboard",
    });
    // Row-count check (not just merged-object equality) — catches a
    // duplicate row landing under the same meta_key, which `toEqual` above
    // couldn't distinguish from a single row.
    const rowCount = await db
      .prepare(`SELECT COUNT(*) AS n FROM file_metadata WHERE workspace = ? AND object_key = ?`)
      .bind(WS, newKey)
      .first<{ n: number }>();
    expect(rowCount?.n).toBe(6);
  });

  it("review fix 2 (Important): resumability — drains leftovers stranded under a PREVIOUSLY retired id for the same (repo, branch), not just the id retired this call", async () => {
    const { env, db, bucket, ws } = await seededEnv();

    // Simulate an earlier, interrupted rotation: id1 was retired but its
    // sweep never finished, so an object is still physically sitting under
    // it even though it is no longer the active row.
    const id1 = await getOrMintPrefixId(db, REPO, BRANCH);
    const strandedKey = ghPrivateBranchAttachmentKey(id1, "stranded.png");
    await putObject(env, ws, strandedKey, PNG, WS, {
      metadata: { "gh.repo": REPO, "gh.kind": "branch" },
    });
    await retirePrefixId(db, REPO, BRANCH, id1);

    // The id this call's own rotation targets — the CURRENT active id, with
    // its own live object.
    const id2 = await getOrMintPrefixId(db, REPO, BRANCH);
    const liveKey = ghPrivateBranchAttachmentKey(id2, "live.png");
    await putObject(env, ws, liveKey, PNG, WS, {
      metadata: { "gh.repo": REPO, "gh.kind": "branch" },
    });

    const result = await withFetch(commentFlowFetch({ bodies: [] }), () =>
      rotatePrivatePrefix(env, ws, WS, "user-1", REPO, BRANCH),
    );

    expect(result.rotated).toBe(true);
    if (!result.rotated) throw new Error("expected rotated: true");
    expect(result.moved).toBe(2);

    const id3 = result.prefixId;
    const newStranded = ghPrivateBranchAttachmentKey(id3, "stranded.png");
    const newLive = ghPrivateBranchAttachmentKey(id3, "live.png");
    expect(bucket.store.has(`${PREFIX}${newStranded}`)).toBe(true);
    expect(bucket.store.has(`${PREFIX}${newLive}`)).toBe(true);
    expect(bucket.store.has(`${PREFIX}${strandedKey}`)).toBe(false);
    expect(bucket.store.has(`${PREFIX}${liveKey}`)).toBe(false);
  });

  it("review fix 3 (Important): a copy failure on object 2 of 2 leaves its old copy intact, propagates the error, but still resyncs object 1's comment via the finally", async () => {
    const { env, db, bucket, ws } = await seededEnv();
    const oldId = await getOrMintPrefixId(db, REPO, BRANCH);

    const goodKey = ghPrivateAttachmentKey(
      oldId,
      { repo: REPO, kind: "pull", num: NUM },
      "a-good.png",
    );
    const badKey = ghPrivateAttachmentKey(
      oldId,
      { repo: REPO, kind: "pull", num: NUM },
      "b-bad.png",
    );

    await putObject(env, ws, goodKey, PNG, WS, {
      metadata: { "gh.repo": REPO, "gh.kind": "pull", "gh.number": String(NUM) },
    });
    // Seeded directly (bypassing `putObject`, which itself rejects an empty
    // body on write) so rotation's own copy step is what discovers the
    // problem, mid-sweep, on the SECOND object (`list()` sorts keys, and
    // "a-good.png" sorts before "b-bad.png").
    await bucket.put(`${PREFIX}${badKey}`, new Uint8Array(0), {
      httpMetadata: { contentType: "image/png" },
    });

    const seen = { bodies: [] as string[] };
    await expect(
      withFetch(commentFlowFetch(seen), () =>
        rotatePrivatePrefix(env, ws, WS, "user-1", REPO, BRANCH),
      ),
    ).rejects.toThrow();

    // Object 2's old copy is untouched — the failure happened before its
    // delete step ever ran, so nothing was lost.
    expect(bucket.store.has(`${PREFIX}${badKey}`)).toBe(true);
    // Object 1 DID finish moving (its old copy is gone).
    expect(bucket.store.has(`${PREFIX}${goodKey}`)).toBe(false);

    // The comment resync for object 1's target still ran, from the
    // `finally`, even though the loop threw partway through on object 2.
    expect(seen.bodies).toHaveLength(1);
  });

  // Rotation is a revocation mechanism: an operator rotating a leaked prefix
  // must never be wedged by one object the active-content gate has since
  // closed on (issue #929 adversarial review M-2). The refused object keeps
  // its old key — the next rotation's resumability sweep retries it.
  it("skips an SVG the active-content gate refuses, moves everything else, and reports it", async () => {
    const { env, db, bucket, ws } = await seededEnv();
    const oldId = await getOrMintPrefixId(db, REPO, BRANCH);
    const pngKey = ghPrivateBranchAttachmentKey(oldId, "shot.png");
    const svgKey = ghPrivateBranchAttachmentKey(oldId, "diagram.svg");
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
    );

    await putObject(env, ws, pngKey, PNG, WS, {
      metadata: { "gh.repo": REPO, "gh.kind": "branch" },
    });
    // Written straight to the bucket: `seededEnv` binds no FLAGS, so a
    // direct put of a gated type would 415 here too. This stands in for an
    // SVG stored while the gate was open.
    await bucket.put(`${PREFIX}${svgKey}`, svg, {
      httpMetadata: { contentType: "image/svg+xml" },
    });

    const result = await withFetch(commentFlowFetch({ bodies: [] }), () =>
      rotatePrivatePrefix(env, ws, WS, "user-1", REPO, BRANCH),
    );

    expect(result.rotated).toBe(true);
    if (!result.rotated) throw new Error("expected rotated: true");
    expect(result.moved).toBe(1);
    expect(result.skipped).toEqual([svgKey]);

    // The PNG moved; the refused SVG kept its old key and never landed at
    // the new prefix.
    const newPngKey = ghPrivateBranchAttachmentKey(result.prefixId, "shot.png");
    const newSvgKey = ghPrivateBranchAttachmentKey(result.prefixId, "diagram.svg");
    expect(bucket.store.has(`${PREFIX}${newPngKey}`)).toBe(true);
    expect(bucket.store.has(`${PREFIX}${pngKey}`)).toBe(false);
    expect(bucket.store.has(`${PREFIX}${newSvgKey}`)).toBe(false);
    expect(bucket.store.has(`${PREFIX}${svgKey}`)).toBe(true);
  });

  it("no active id → { rotated: false, reason: 'no_prefix' }", async () => {
    const { env, ws } = await seededEnv();
    const result = await rotatePrivatePrefix(env, ws, WS, "user-1", REPO, "unminted-branch");
    expect(result).toEqual({ rotated: false, reason: "no_prefix" });
  });

  it("unauthorized caller (repo bound to a different workspace): rotation errors rather than degrading", async () => {
    const { env, db, ws } = await seededEnv({ linked: false });
    await recordRepoLink(db, REPO, "other-ws", "test");
    await getOrMintPrefixId(db, REPO, BRANCH);

    await expect(rotatePrivatePrefix(env, ws, WS, "user-1", REPO, BRANCH)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("sanity: GH_PRIVATE_ROOT stays the base this module sweeps under", () => {
    expect(GH_PRIVATE_ROOT).toBe("gh/private/");
  });

  it("review fix 4: the D1 rewrites for github_ingested_assets and gallery_items are scoped to this workspace — a same-object_key row belonging to another workspace is untouched", async () => {
    const { env, db, ws } = await seededEnv();
    const oldId = await getOrMintPrefixId(db, REPO, BRANCH);
    const pullKey = ghPrivateAttachmentKey(
      oldId,
      { repo: REPO, kind: "pull", num: NUM },
      "shot.png",
    );

    await putObject(env, ws, pullKey, PNG, WS, {
      metadata: { "gh.repo": REPO, "gh.kind": "pull", "gh.number": String(NUM) },
    });

    // Same object_key, but recorded under a DIFFERENT workspace — object
    // keys are workspace-relative strings, not globally unique, so an
    // unscoped rewrite would rename this row too.
    await recordIngestedAsset(db, {
      repo: REPO,
      assetId: "assets/other-ws-asset",
      workspace: "other-ws",
      objectKey: pullKey,
      kind: "pull",
      num: NUM,
      source: "body",
      createdAt: new Date().toISOString(),
    });

    // Same shape for gallery_items, via a gallery that belongs to the other
    // workspace — gallery_items has no workspace column of its own, so
    // scoping has to go through the parent `galleries` row.
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO galleries (id, workspace, title, visibility, version, created_at, updated_at)
         VALUES (?, ?, ?, 'public', 1, ?, ?)`,
      )
      .bind("gallery-other-ws", "other-ws", "Other workspace gallery", now, now)
      .run();
    await db
      .prepare(
        `INSERT INTO gallery_items (id, gallery_id, object_key, position, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind("item-other-ws", "gallery-other-ws", pullKey, 1, now)
      .run();

    // And this workspace's own gallery_items row for the SAME object_key,
    // which must still be rewritten normally.
    await db
      .prepare(
        `INSERT INTO galleries (id, workspace, title, visibility, version, created_at, updated_at)
         VALUES (?, ?, ?, 'public', 1, ?, ?)`,
      )
      .bind("gallery-ws", WS, "This workspace gallery", now, now)
      .run();
    await db
      .prepare(
        `INSERT INTO gallery_items (id, gallery_id, object_key, position, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind("item-ws", "gallery-ws", pullKey, 1, now)
      .run();

    const result = await withFetch(commentFlowFetch({ bodies: [] }), () =>
      rotatePrivatePrefix(env, ws, WS, "user-1", REPO, BRANCH),
    );

    expect(result.rotated).toBe(true);
    if (!result.rotated) throw new Error("expected rotated: true");
    const newKey = ghPrivateAttachmentKey(
      result.prefixId,
      { repo: REPO, kind: "pull", num: NUM },
      "shot.png",
    );

    // The other workspace's ledger row still points at the OLD key.
    const otherLedger = await ledgerRow(db, REPO, "assets/other-ws-asset");
    expect(otherLedger?.objectKey).toBe(pullKey);

    // The other workspace's gallery_items row is also untouched.
    const otherItem = await db
      .prepare(`SELECT object_key FROM gallery_items WHERE id = ?`)
      .bind("item-other-ws")
      .first<{ object_key: string }>();
    expect(otherItem?.object_key).toBe(pullKey);

    // This workspace's own gallery_items row DID follow the rename.
    const ownItem = await db
      .prepare(`SELECT object_key FROM gallery_items WHERE id = ?`)
      .bind("item-ws")
      .first<{ object_key: string }>();
    expect(ownItem?.object_key).toBe(newKey);
  });

  it("issue #934: rotation re-keys the attachment index row onto the new prefix, preserving the old row's identity", async () => {
    const { env, db, ws } = await seededEnv();
    const oldId = await getOrMintPrefixId(db, REPO, BRANCH);
    const pullKey = ghPrivateAttachmentKey(
      oldId,
      { repo: REPO, kind: "pull", num: NUM },
      "hero.png",
    );

    await putObject(env, ws, pullKey, PNG, WS, {
      metadata: { "gh.repo": REPO, "gh.kind": "pull", "gh.number": String(NUM) },
    });
    // `putObject` above already wrote a `source: "put"` row via its own
    // best-effort index write — overwrite it here with a distinguishing
    // `source`/`laneId` so the assertion below can tell "the OLD row
    // survived the rename" apart from "a fresh row for the new key got
    // created independently" (which would also happen to have `repo`/`num`
    // right, since `putObject` resolves those from the `gh.*` metadata).
    await recordAttachment(db, {
      workspace: WS,
      repo: REPO,
      kind: "pull",
      num: NUM,
      objectKey: pullKey,
      prefixId: oldId,
      laneId: "lane-a",
      source: "attach",
    });

    const result = await withFetch(commentFlowFetch({ bodies: [] }), () =>
      rotatePrivatePrefix(env, ws, WS, "user-1", REPO, BRANCH),
    );

    expect(result.rotated).toBe(true);
    if (!result.rotated) throw new Error("expected rotated: true");
    const newId = result.prefixId;
    const newKey = ghPrivateAttachmentKey(
      newId,
      { repo: REPO, kind: "pull", num: NUM },
      "hero.png",
    );

    expect(await attachmentRow(db, WS, pullKey)).toBeNull();
    expect(await attachmentRow(db, WS, newKey)).toMatchObject({
      repo: REPO,
      prefixId: newId,
      num: NUM,
      source: "attach",
      // Not "lane-a" (the OLD row's lane): rotation re-uploads the bytes
      // through `putObject` into whichever lane is currently active for
      // `ws`, and `seededEnv`'s `ws` has no `storageLaneId`, so the moved
      // row must carry `ws.storageLaneId ?? null`, not the stale lane.
      laneId: ws.storageLaneId ?? null,
    });
  });
});
