/**
 * Service-level coverage for `rotatePrivatePrefix` (issue #631, Task 8) —
 * mint a fresh id, move every object under the old id, rename the D1 rows
 * that point at those object keys, retire the old row, and re-sync the
 * managed comment for every PR/issue that had a moved object. Route
 * coverage (403 unauthorized, 200 shape) lives in
 * `routes/github-private-prefix-rotate.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { getFileMetadata } from "./file-metadata";
import { putObject } from "./files-core";
import {
  ghPrivateAttachmentKey,
  ghPrivateBranchAttachmentKey,
  GH_PRIVATE_ROOT,
} from "./github-comment-render";
import { attachmentsMarker } from "./github-comment-render";
import { rotatePrivatePrefix } from "./github-private-prefix-service";
import { getActivePrefixId, getOrMintPrefixId } from "./github-private-prefixes";
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
  "migrations/20260711180000_galleries.sql",
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20260720120000_github_repo_links.sql",
  "migrations/20260721150000_github_pr_activity.sql",
  "migrations/20260724140000_file_content_hash.sql",
  "migrations/20260728120000_daily_metrics.sql",
  "migrations/20260730170533_delete_usage_claims.sql",
  "migrations/20260811120000_github_ingested_assets.sql",
  "migrations/20260811210000_github_private_prefixes.sql",
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
});
