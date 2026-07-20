import { describe, expect, it } from "vitest";
import {
  isPurgedTombstone,
  loadWorkspaceRecord,
  loadWorkspaceRecordRaw,
  WORKSPACE_DELETE_GRACE_DAYS,
  type PurgedTombstone,
  type WorkspaceRecord,
} from "./workspace";

const RECORD: WorkspaceRecord = {
  provider: "r2",
  bucket: "shared",
  binding: "UPLOADS_DEFAULT",
  prefix: "acme/",
  publicBaseUrl: "https://storage.uploads.sh",
};

function fakeRegistry(records: Record<string, unknown>): Env["REGISTRY"] {
  const store = new Map(Object.entries(records));
  return {
    get: (async (key: string) => store.get(key) ?? null) as unknown,
  } as Env["REGISTRY"];
}

describe("loadWorkspaceRecord (#247 soft-delete filtering)", () => {
  it("returns the record for a normal workspace", async () => {
    const env = { REGISTRY: fakeRegistry({ "ws:acme": RECORD }) } as unknown as Env;
    expect(await loadWorkspaceRecord(env, "acme")).toEqual({ ...RECORD, name: "acme" });
  });

  it("stamps name from the lookup key, not the stored JSON, even when the JSON has a different/absent name (#303)", async () => {
    const stale: WorkspaceRecord = { ...RECORD, name: "stale-old-name" };
    const env = { REGISTRY: fakeRegistry({ "ws:acme": stale }) } as unknown as Env;
    expect((await loadWorkspaceRecord(env, "acme"))?.name).toBe("acme");
    const raw = (await loadWorkspaceRecordRaw(env, "acme")) as WorkspaceRecord | null;
    expect(raw?.name).toBe("acme");
  });

  it("returns null for a soft-deleted workspace (auth path denies like unknown)", async () => {
    const softDeleted: WorkspaceRecord = {
      ...RECORD,
      deletedAt: "2026-07-01T00:00:00.000Z",
      purgeAt: "2026-07-15T00:00:00.000Z",
    };
    const env = { REGISTRY: fakeRegistry({ "ws:acme": softDeleted }) } as unknown as Env;
    expect(await loadWorkspaceRecord(env, "acme")).toBeNull();
    // But the raw read (used by admin routes / the sweep) still sees it, stamped too.
    expect(await loadWorkspaceRecordRaw(env, "acme")).toEqual({ ...softDeleted, name: "acme" });
  });

  it("returns null for a purged tombstone", async () => {
    const tombstone: PurgedTombstone = {
      status: "purged",
      name: "acme",
      purgedAt: "2026-07-15T00:00:00.000Z",
    };
    const env = { REGISTRY: fakeRegistry({ "ws:acme": tombstone }) } as unknown as Env;
    expect(await loadWorkspaceRecord(env, "acme")).toBeNull();
    expect(isPurgedTombstone(await loadWorkspaceRecordRaw(env, "acme"))).toBe(true);
  });

  it("returns null for an unknown workspace", async () => {
    const env = { REGISTRY: fakeRegistry({}) } as unknown as Env;
    expect(await loadWorkspaceRecord(env, "acme")).toBeNull();
  });

  it("registration's raw KV existence check still sees soft-deleted/purged records as taken", async () => {
    // Mirrors routes/workspaces.ts:80 — a direct `REGISTRY.get` (no filtering)
    // is what registration uses to reject an already-registered name; both
    // soft-deleted records and purged tombstones must still read non-null.
    const softDeleted: WorkspaceRecord = { ...RECORD, deletedAt: "2026-07-01T00:00:00.000Z" };
    const tombstone: PurgedTombstone = {
      status: "purged",
      name: "acme",
      purgedAt: "2026-07-15T00:00:00.000Z",
    };
    const registry = fakeRegistry({ "ws:soft": softDeleted, "ws:purged": tombstone });
    expect(await registry.get("ws:soft")).not.toBeNull();
    expect(await registry.get("ws:purged")).not.toBeNull();
  });

  it("grace window constant is 14 days", () => {
    expect(WORKSPACE_DELETE_GRACE_DAYS).toBe(14);
  });
});
