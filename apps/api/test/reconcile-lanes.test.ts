/**
 * CodeRabbit review (PR #771): `reconcileWorkspaceUsage` walks the active
 * lane only (`// PR D:` marker in reconcile.ts) — for a workspace with a
 * fallback lane that may hold objects, that would zero the fallback's
 * bytes/objects out of the ledger. Until PR D makes reconcile lane-aware, it
 * must refuse rather than silently corrupt the ledger.
 */
import { describe, expect, it } from "vitest";
import { reconcileWorkspaceUsage } from "../src/reconcile";
import { makePosterEnv, PNG, WORKSPACE } from "./poster-fixtures";
import { putObject } from "../src/files-core";
import type { StorageLane } from "../src/workspace";

describe("reconcileWorkspaceUsage and multi-lane records", () => {
  it("refuses a record with a fallback lane, leaving the ledger untouched", async () => {
    const { env, ws, db } = makePosterEnv();
    await putObject(env, ws, "screenshots/shot.png", PNG, WORKSPACE);
    const before = db.usage.get(WORKSPACE);

    const fallback: StorageLane = {
      id: "lane_fallback1",
      provider: "r2",
      bucket: "customer-bucket",
      binding: "UPLOADS_FALLBACK",
      lastActiveAt: "2026-08-01T00:00:00.000Z",
    };
    const wsWithFallback = { ...ws, storageLanes: [fallback] };

    await expect(reconcileWorkspaceUsage(env, wsWithFallback, WORKSPACE)).rejects.toMatchObject({
      code: "reconcile_multi_lane_unsupported",
    });
    expect(db.usage.get(WORKSPACE)).toEqual(before);
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
