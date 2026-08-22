/**
 * Task C3 (two-lane storage, PR C): `deleteObject` deletes a key from every
 * lane that holds it, not just the active one — after a detach/re-attach
 * cycle a key can exist in more than one lane, and every copy must go so the
 * file actually disappears. See
 * docs/superpowers/specs/2026-08-22-two-lane-storage-design.md, "Read path".
 */
import { describe, expect, it } from "vitest";
import { FakeR2Bucket } from "./fake-r2";
import { deleteObject, putObject } from "../src/files-core";
import { makePosterEnv, PNG, WORKSPACE } from "./poster-fixtures";
import type { StorageLane, WorkspaceRecord } from "../src/workspace";

const FALLBACK_LANE: StorageLane = {
  id: "lane_fallback1",
  provider: "r2",
  bucket: "customer-bucket",
  binding: "UPLOADS_FALLBACK",
  lastActiveAt: "2026-08-01T00:00:00.000Z",
  publicBaseUrl: "https://storage.customer.example.com",
};

describe("deleteObject across storage lanes", () => {
  it("deletes a key present in both the active and fallback lanes", async () => {
    const { env, bucket, db, ws } = makePosterEnv();
    const fallback = new FakeR2Bucket();
    (env as unknown as Record<string, FakeR2Bucket>).UPLOADS_FALLBACK = fallback;
    // No `prefix` on FALLBACK_LANE, unlike the active lane's "default/" —
    // raw fallback keys are unprefixed.
    await fallback.put("screenshots/shot.png", PNG);

    const wsWithLanes: WorkspaceRecord = { ...ws, storageLanes: [FALLBACK_LANE] };
    await putObject(env, wsWithLanes, "screenshots/shot.png", PNG, WORKSPACE);
    expect(bucket.store.has("default/screenshots/shot.png")).toBe(true);
    expect(fallback.store.has("screenshots/shot.png")).toBe(true);

    await deleteObject(env, wsWithLanes, "screenshots/shot.png", WORKSPACE);
    expect(bucket.store.has("default/screenshots/shot.png")).toBe(false);
    expect(fallback.store.has("screenshots/shot.png")).toBe(false);
    // Ledger counted the object once (active-lane hit, active-first order).
    expect(db.usage.get(WORKSPACE)).toMatchObject({ bytes: 0, objects: 0 });
  });

  it("deletes a key present only in the fallback lane (no 404, active lane untouched)", async () => {
    const { env, bucket, ws } = makePosterEnv();
    const fallback = new FakeR2Bucket();
    (env as unknown as Record<string, FakeR2Bucket>).UPLOADS_FALLBACK = fallback;
    await fallback.put("legacy/only-fallback.png", PNG);

    const wsWithLanes: WorkspaceRecord = { ...ws, storageLanes: [FALLBACK_LANE] };
    await expect(
      deleteObject(env, wsWithLanes, "legacy/only-fallback.png", WORKSPACE),
    ).resolves.toEqual({ key: "legacy/only-fallback.png", deleted: true });
    expect(fallback.store.has("legacy/only-fallback.png")).toBe(false);
    expect(bucket.store.size).toBe(0);
  });

  it("single-lane record deletes exactly as before (control)", async () => {
    const { env, bucket, db, ws } = makePosterEnv();
    const put = await putObject(env, ws, "screenshots/shot.png", PNG, WORKSPACE);
    await deleteObject(env, ws, put.key, WORKSPACE);
    expect(bucket.store.has(`default/${put.key}`)).toBe(false);
    expect(db.usage.get(WORKSPACE)).toMatchObject({ bytes: 0, objects: 0 });
  });
});
