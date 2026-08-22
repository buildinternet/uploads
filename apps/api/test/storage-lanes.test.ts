/**
 * Task B2 (two-lane storage primitive, no behavior change yet — nothing
 * writes `storageLanes` before PR D): `storageConfigs` walks the active lane
 * plus every fallback lane (standby lanes excluded); `resolveObjectLane`
 * walks them in order and returns the first lane whose store has the key.
 * See docs/superpowers/specs/2026-08-22-two-lane-storage-design.md.
 */
import { describe, expect, it, vi } from "vitest";
import { FakeR2Bucket } from "./fake-r2";
import { resolveObjectLane, storageConfigs } from "../src/storage";
import type { StorageLane, WorkspaceRecord } from "../src/workspace";

function makeEnv(bindings: Record<string, FakeR2Bucket>) {
  return { WORKSPACE_SECRETS_KEY: "test-master-secret-key!!", ...bindings } as unknown as Env;
}

// No `prefix` here so raw keys written into the fake buckets line up exactly
// with the keys `exists()` is asked about — a prefix mismatch between the
// active and fallback fixtures would silently point lookups at different
// underlying keys.
const ACTIVE_WS: WorkspaceRecord = {
  provider: "r2",
  bucket: "uploads-default",
  binding: "UPLOADS_DEFAULT",
  publicBaseUrl: "https://storage.uploads.sh",
};

const FALLBACK_LANE: StorageLane = {
  id: "lane_fallback1",
  provider: "r2",
  bucket: "customer-bucket",
  binding: "UPLOADS_FALLBACK",
  lastActiveAt: "2026-08-01T00:00:00.000Z",
  publicBaseUrl: "https://customer.example.com",
};

describe("storageConfigs", () => {
  it("returns a single active entry for a record with no lanes", async () => {
    const env = makeEnv({ UPLOADS_DEFAULT: new FakeR2Bucket() });
    const configs = await storageConfigs(env, ACTIVE_WS);
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ laneId: null, role: "active" });
  });

  it("includes a fallback lane after the active lane, in order", async () => {
    const env = makeEnv({
      UPLOADS_DEFAULT: new FakeR2Bucket(),
      UPLOADS_FALLBACK: new FakeR2Bucket(),
    });
    const ws: WorkspaceRecord = {
      ...ACTIVE_WS,
      storageLaneId: "lane_active1",
      storageLanes: [FALLBACK_LANE],
    };
    const configs = await storageConfigs(env, ws);
    expect(configs).toHaveLength(2);
    expect(configs[0]).toMatchObject({ laneId: "lane_active1", role: "active" });
    expect(configs[1]).toMatchObject({ laneId: "lane_fallback1", role: "fallback" });
  });

  it("excludes a standby lane (no lastActiveAt)", async () => {
    const env = makeEnv({
      UPLOADS_DEFAULT: new FakeR2Bucket(),
      UPLOADS_FALLBACK: new FakeR2Bucket(),
    });
    const standby: StorageLane = { ...FALLBACK_LANE, lastActiveAt: undefined };
    const ws: WorkspaceRecord = { ...ACTIVE_WS, storageLanes: [standby] };
    const configs = await storageConfigs(env, ws);
    expect(configs).toHaveLength(1);
    expect(configs[0]?.role).toBe("active");
  });

  it("skips a fallback lane naming a nonexistent binding without throwing, keeping the active lane", async () => {
    const env = makeEnv({ UPLOADS_DEFAULT: new FakeR2Bucket() });
    const badLane: StorageLane = { ...FALLBACK_LANE, binding: "NO_SUCH_BINDING" };
    const ws: WorkspaceRecord = { ...ACTIVE_WS, storageLanes: [badLane] };
    const configs = await storageConfigs(env, ws);
    expect(configs).toHaveLength(1);
    expect(configs[0]?.role).toBe("active");
  });

  it("skips a fallback lane whose provider is not r2", async () => {
    const env = makeEnv({
      UPLOADS_DEFAULT: new FakeR2Bucket(),
      UPLOADS_FALLBACK: new FakeR2Bucket(),
    });
    const badLane: StorageLane = { ...FALLBACK_LANE, provider: "s3" };
    const ws: WorkspaceRecord = { ...ACTIVE_WS, storageLanes: [badLane] };
    const configs = await storageConfigs(env, ws);
    expect(configs).toHaveLength(1);
    expect(configs[0]?.role).toBe("active");
  });
});

describe("resolveObjectLane", () => {
  it("finds a key present only in the fallback store", async () => {
    const active = new FakeR2Bucket();
    const fallback = new FakeR2Bucket();
    await fallback.put("default/only-in-fallback.png", new Uint8Array([1]));
    const env = makeEnv({ UPLOADS_DEFAULT: active, UPLOADS_FALLBACK: fallback });
    const ws: WorkspaceRecord = { ...ACTIVE_WS, storageLanes: [FALLBACK_LANE] };

    const resolved = await resolveObjectLane(env, ws, "default/only-in-fallback.png");
    expect(resolved?.laneId).toBe("lane_fallback1");
    expect(resolved?.role).toBe("fallback");
  });

  it("prefers the active lane when the key is present in both", async () => {
    const active = new FakeR2Bucket();
    const fallback = new FakeR2Bucket();
    await active.put("default/both.png", new Uint8Array([1]));
    await fallback.put("default/both.png", new Uint8Array([2]));
    const env = makeEnv({ UPLOADS_DEFAULT: active, UPLOADS_FALLBACK: fallback });
    const ws: WorkspaceRecord = { ...ACTIVE_WS, storageLanes: [FALLBACK_LANE] };

    const resolved = await resolveObjectLane(env, ws, "default/both.png");
    expect(resolved?.laneId).toBeNull();
    expect(resolved?.role).toBe("active");
  });

  it("returns null when the key is in neither lane", async () => {
    const env = makeEnv({
      UPLOADS_DEFAULT: new FakeR2Bucket(),
      UPLOADS_FALLBACK: new FakeR2Bucket(),
    });
    const ws: WorkspaceRecord = { ...ACTIVE_WS, storageLanes: [FALLBACK_LANE] };

    const resolved = await resolveObjectLane(env, ws, "default/nowhere.png");
    expect(resolved).toBeNull();
  });

  it("short-circuits to a single exists() call for a single-lane record", async () => {
    const active = new FakeR2Bucket();
    const env = makeEnv({ UPLOADS_DEFAULT: active });
    let existsCalls = 0;
    const originalHead = active.head.bind(active);
    active.head = async (key: string) => {
      existsCalls++;
      return originalHead(key);
    };
    await resolveObjectLane(env, ACTIVE_WS, "default/whatever.png");
    expect(existsCalls).toBe(1);
  });

  it("never resolves a fallback lane's config when the active lane already has the key (lazy walk)", async () => {
    // The fallback lane names a binding that doesn't exist on env — resolving
    // it would log a "storage_lane_skipped" error. A lazy walk never attempts
    // it once the active lane hits, so console.error must stay silent.
    const active = new FakeR2Bucket();
    await active.put("default/only-active.png", new Uint8Array([1]));
    const env = makeEnv({ UPLOADS_DEFAULT: active });
    const badLane: StorageLane = { ...FALLBACK_LANE, binding: "NO_SUCH_BINDING" };
    const ws: WorkspaceRecord = { ...ACTIVE_WS, storageLanes: [badLane] };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const resolved = await resolveObjectLane(env, ws, "default/only-active.png");
      expect(resolved?.role).toBe("active");
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
