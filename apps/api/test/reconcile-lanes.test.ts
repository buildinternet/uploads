import { describe, expect, it } from "vitest";
import { reconcileWorkspaceUsage } from "../src/reconcile";
import { makePosterEnv, PNG, WORKSPACE } from "./poster-fixtures";
import { putObject } from "../src/files-core";
import { FakeR2Bucket } from "./fake-r2";
import type { StorageLane } from "../src/workspace";

describe("reconcileWorkspaceUsage and multi-lane records", () => {
  it("rebuilds total and shared usage across active and fallback lanes", async () => {
    const { env, ws, db } = makePosterEnv();
    await putObject(env, ws, "screenshots/shot.png", PNG, WORKSPACE);
    const fallbackBucket = new FakeR2Bucket();
    (env as unknown as Record<string, unknown>).UPLOADS_FALLBACK = fallbackBucket;
    await fallbackBucket.put("legacy.png", new Uint8Array(21));

    const fallback: StorageLane = {
      id: "lane_fallback1",
      provider: "r2",
      bucket: "customer-bucket",
      binding: "UPLOADS_FALLBACK",
      lastActiveAt: "2026-08-01T00:00:00.000Z",
    };
    const wsWithFallback = { ...ws, storageLanes: [fallback] };

    const result = await reconcileWorkspaceUsage(env, wsWithFallback, WORKSPACE);
    expect(result).toMatchObject({
      bytes: PNG.byteLength + 21,
      objects: 2,
    });
    expect(db.usage.get(WORKSPACE)).toMatchObject({
      bytes: PNG.byteLength + 21,
      objects: 2,
      shared_bytes: PNG.byteLength + 21,
      shared_objects: 2,
    });
  });

  it("does not refuse a record with only a standby lane (no lastActiveAt)", async () => {
    const { env, ws } = makePosterEnv();
    await putObject(env, ws, "screenshots/shot.png", PNG, WORKSPACE);

    const standby: StorageLane = {
      id: "lane_standby1",
      provider: "r2",
      bucket: "customer-bucket",
      binding: "UPLOADS_FALLBACK",
      // No `lastActiveAt` — saved config, never a read source.
    };
    const wsWithStandby = { ...ws, storageLanes: [standby] };

    const result = await reconcileWorkspaceUsage(env, wsWithStandby, WORKSPACE);
    expect(result.bytes).toBe(PNG.byteLength);
    expect(result.objects).toBe(1);
  });

  it("single-lane record reconciles as today (control)", async () => {
    const { env, ws, db } = makePosterEnv();
    await putObject(env, ws, "screenshots/shot.png", PNG, WORKSPACE);
    const result = await reconcileWorkspaceUsage(env, ws, WORKSPACE);
    expect(result.bytes).toBe(PNG.byteLength);
    expect(result.objects).toBe(1);
    expect(db.usage.get(WORKSPACE)).toMatchObject({ bytes: PNG.byteLength, objects: 1 });
  });
});
