import { describe, expect, it } from "vitest";
import {
  clearSnapshotsIn,
  readSnapshotFrom,
  toWorkspaceSnapshot,
  workspaceSnapshotKey,
  writeSnapshotTo,
  WORKSPACE_SNAPSHOT_TTL_MS,
  type KeyValueStore,
  type WorkspaceSnapshot,
} from "./workspace-cache";

/** Minimal in-memory Storage stand-in — tests run in node, which has none. */
function fakeStore(
  seed: Record<string, string> = {},
): KeyValueStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

function snapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    slug: "buildinternet",
    role: "owner",
    hasPublicUrl: true,
    publicBaseUrl: "https://media.buildinternet.dev",
    plan: "free",
    usage: { bytes: 8_500_000, objects: 78, uploadsInPeriod: 15, maxStorageBytes: 10_000_000_000 },
    ...overrides,
  };
}

describe("workspaceSnapshotKey", () => {
  // Pins the format the AccountLayout inline boot script and any future
  // non-importing consumer must hardcode. Changing it is a breaking change.
  it("namespaces the workspace slug under the uploads:ws: prefix", () => {
    expect(workspaceSnapshotKey("buildinternet")).toBe("uploads:ws:buildinternet");
  });
});

describe("readSnapshotFrom / writeSnapshotTo", () => {
  it("round-trips a snapshot", () => {
    const store = fakeStore();
    writeSnapshotTo(store, "buildinternet", snapshot(), 1000);
    expect(readSnapshotFrom(store, "buildinternet", 1000)).toEqual(snapshot());
  });

  it("returns null for a workspace that was never written", () => {
    expect(readSnapshotFrom(fakeStore(), "missing", 1000)).toBeNull();
  });

  it("returns null once the entry is older than the TTL", () => {
    const store = fakeStore();
    writeSnapshotTo(store, "buildinternet", snapshot(), 1000);
    expect(
      readSnapshotFrom(store, "buildinternet", 1000 + WORKSPACE_SNAPSHOT_TTL_MS + 1),
    ).toBeNull();
  });

  it("evicts the expired entry rather than leaving it to rot", () => {
    const store = fakeStore();
    writeSnapshotTo(store, "buildinternet", snapshot(), 1000);
    readSnapshotFrom(store, "buildinternet", 1000 + WORKSPACE_SNAPSHOT_TTL_MS + 1);
    expect(store.map.has("uploads:ws:buildinternet")).toBe(false);
  });

  it("returns null when the stored schema version is not the current one", () => {
    const store = fakeStore({
      "uploads:ws:buildinternet": JSON.stringify({ v: 0, at: 1000, data: snapshot() }),
    });
    expect(readSnapshotFrom(store, "buildinternet", 1000)).toBeNull();
  });

  it("returns null for unparseable JSON instead of throwing", () => {
    const store = fakeStore({ "uploads:ws:buildinternet": "{not json" });
    expect(readSnapshotFrom(store, "buildinternet", 1000)).toBeNull();
  });

  it("returns null when the payload is missing its data object", () => {
    const store = fakeStore({ "uploads:ws:buildinternet": JSON.stringify({ v: 1, at: 1000 }) });
    expect(readSnapshotFrom(store, "buildinternet", 1000)).toBeNull();
  });

  it("swallows a quota-exceeded write so the caller still renders", () => {
    const store = fakeStore();
    store.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => writeSnapshotTo(store, "buildinternet", snapshot(), 1000)).not.toThrow();
  });
});

describe("clearSnapshotsIn", () => {
  it("removes every workspace snapshot and leaves unrelated keys alone", () => {
    const store = fakeStore({
      "uploads:ws:one": JSON.stringify({ v: 1, at: 1, data: snapshot() }),
      "uploads:ws:two": JSON.stringify({ v: 1, at: 1, data: snapshot() }),
      "uploads:activeWorkspace": "one",
      unrelated: "keep",
    });
    clearSnapshotsIn(store);
    expect([...store.map.keys()].sort()).toEqual(["unrelated", "uploads:activeWorkspace"]);
  });
});

describe("toWorkspaceSnapshot", () => {
  it("projects the summary response onto the cached shape", () => {
    const result = toWorkspaceSnapshot(
      {
        workspace: "buildinternet",
        organization: { id: "org_1", slug: "buildinternet", name: "BuildInternet" },
        role: "owner",
        hasPublicUrl: true,
        publicBaseUrl: "https://media.buildinternet.dev",
        plan: "free",
      },
      {
        workspace: "buildinternet",
        bytes: 8_500_000,
        objects: 78,
        uploadsInPeriod: 15,
        periodStart: "2026-07-01",
        updatedAt: "2026-07-24",
        maxStorageBytes: 10_000_000_000,
      },
    );
    expect(result).toEqual({
      slug: "buildinternet",
      role: "owner",
      hasPublicUrl: true,
      publicBaseUrl: "https://media.buildinternet.dev",
      plan: "free",
      usage: {
        bytes: 8_500_000,
        objects: 78,
        uploadsInPeriod: 15,
        maxStorageBytes: 10_000_000_000,
        maxUploadsPerPeriod: undefined,
      },
    });
  });

  it("omits usage entirely when the summary carried none", () => {
    const result = toWorkspaceSnapshot(
      {
        workspace: "solo",
        organization: { id: "org_2", slug: "solo", name: "Solo" },
        role: "member",
        hasPublicUrl: false,
      },
      null,
    );
    expect(result.usage).toBeUndefined();
    expect(result.slug).toBe("solo");
  });
});
