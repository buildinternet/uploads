import { describe, expect, it } from "vitest";
import { workspaceKeyMetadata as scriptMetadata } from "../scripts/workspace-key-metadata.mjs";
import { fakeRegistry } from "../test/fake-kv";
import type { PurgedTombstone, WorkspaceRecord } from "./workspace";
import {
  backfillWorkspaceKeyMetadata,
  isByoRecord,
  listWorkspaceByobStatus,
  parseWorkspaceKeyMetadata,
  workspaceKeyMetadata,
} from "./workspace-byob";

const SHARED: WorkspaceRecord = { provider: "r2", bucket: "b", binding: "UPLOADS" };
const BYO: WorkspaceRecord = {
  provider: "r2",
  bucket: "b",
  accountId: "acc",
  accessKeyId: "ak",
  secretAccessKey: "sk",
};
const S3_BYO: WorkspaceRecord = {
  provider: "s3",
  bucket: "b",
  endpoint: "https://s3.example.test",
  accessKeyId: "ak",
  secretAccessKey: "sk",
} as WorkspaceRecord;
const TOMBSTONE: PurgedTombstone = { status: "purged", name: "gone", purgedAt: "2026-01-01" };

const envFor = (registry: ReturnType<typeof fakeRegistry>) =>
  ({ REGISTRY: registry }) as unknown as Env;

describe("workspaceKeyMetadata", () => {
  it("flags customer-credential records as byob", () => {
    expect(workspaceKeyMetadata(BYO)).toEqual({ byob: true });
    expect(workspaceKeyMetadata(S3_BYO)).toEqual({ byob: true });
    expect(workspaceKeyMetadata(SHARED)).toEqual({ byob: false });
  });

  it("never counts soft-deleted records or tombstones as byob", () => {
    expect(workspaceKeyMetadata({ ...BYO, deletedAt: "2026-01-01" })).toEqual({ byob: false });
    expect(workspaceKeyMetadata(TOMBSTONE)).toEqual({ byob: false });
  });

  it("agrees with the operator-script copy of the predicate", () => {
    for (const record of [SHARED, BYO, S3_BYO, { ...BYO, deletedAt: "x" }, TOMBSTONE, {}]) {
      expect(scriptMetadata(record)).toEqual(workspaceKeyMetadata(record as WorkspaceRecord));
    }
    expect(isByoRecord(BYO)).toBe(true);
  });
});

describe("parseWorkspaceKeyMetadata", () => {
  it("returns null for absent or malformed metadata", () => {
    expect(parseWorkspaceKeyMetadata(undefined)).toBeNull();
    expect(parseWorkspaceKeyMetadata(null)).toBeNull();
    expect(parseWorkspaceKeyMetadata({})).toBeNull();
    expect(parseWorkspaceKeyMetadata({ byob: "yes" })).toBeNull();
    expect(parseWorkspaceKeyMetadata({ byob: true })).toEqual({ byob: true });
  });
});

describe("listWorkspaceByobStatus", () => {
  it("uses metadata when present and reads a record only for keys missing it", async () => {
    const registry = fakeRegistry({ meta: SHARED, legacy: BYO, legacyshared: SHARED });
    registry.metadata.set("ws:meta", { byob: true }); // deliberately differs from the blob
    let gets = 0;
    const get = registry.get;
    registry.get = ((...args: Parameters<typeof get>) => {
      gets += 1;
      return get(...args);
    }) as typeof get;

    const status = await listWorkspaceByobStatus(envFor(registry));
    expect(Object.fromEntries(status)).toEqual({ meta: true, legacy: true, legacyshared: false });
    expect(gets).toBe(2); // only the two keys without metadata
  });

  it("propagates a registry failure instead of returning an empty map", async () => {
    const registry = fakeRegistry({ a: SHARED });
    registry.list = (async () => {
      throw new Error("kv down");
    }) as unknown as typeof registry.list;
    await expect(listWorkspaceByobStatus(envFor(registry))).rejects.toThrow("kv down");
  });
});

describe("backfillWorkspaceKeyMetadata", () => {
  it("stamps missing or stale metadata, leaves the blob alone, and is idempotent", async () => {
    const registry = fakeRegistry({ a: BYO, b: SHARED, c: SHARED });
    registry.metadata.set("ws:c", { byob: false });
    const before = registry.store.get("ws:a");

    const dry = await backfillWorkspaceKeyMetadata(envFor(registry), { dryRun: true });
    expect(dry).toMatchObject({ scanned: 3, updated: 2, skipped: 1, dryRun: true });
    expect(registry.puts).toHaveLength(0);

    const run = await backfillWorkspaceKeyMetadata(envFor(registry));
    expect(run).toMatchObject({ scanned: 3, updated: 2, skipped: 1, errors: [] });
    expect(registry.metadata.get("ws:a")).toEqual({ byob: true });
    expect(registry.metadata.get("ws:b")).toEqual({ byob: false });
    expect(registry.store.get("ws:a")).toBe(before);

    const again = await backfillWorkspaceKeyMetadata(envFor(registry));
    expect(again).toMatchObject({ updated: 0, skipped: 3 });
  });
});
