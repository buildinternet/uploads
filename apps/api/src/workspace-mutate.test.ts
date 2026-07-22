import { AppError } from "@uploads/errors";
import { describe, expect, it } from "vitest";
import type { WorkspaceRecord } from "./workspace";
import {
  WORKSPACE_MUTATION_ATTEMPTS,
  mutateWorkspaceRecord,
  workspaceRecordVersion,
} from "./workspace-mutate";

const BASE: WorkspaceRecord = { provider: "r2", bucket: "b", binding: "UPLOADS" };

/**
 * KV fake with a `beforeGet` hook, so a test can simulate another writer's
 * `put` landing at an exact point in the read-mutate-write cycle.
 */
class RacyKv {
  store = new Map<string, string>();
  gets = 0;
  puts = 0;
  beforeGet: ((gets: number) => void) | undefined;

  constructor(seed: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(seed)) this.store.set(key, JSON.stringify(value));
  }

  get = async (key: string, opts?: unknown): Promise<unknown> => {
    this.gets += 1;
    this.beforeGet?.(this.gets);
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    const json = typeof opts === "object" && opts !== null && "type" in opts;
    return json || opts === "json" ? JSON.parse(raw) : raw;
  };

  put = async (key: string, value: string): Promise<void> => {
    this.puts += 1;
    this.store.set(key, value);
  };

  read(name: string): WorkspaceRecord {
    return JSON.parse(this.store.get(`ws:${name}`)!) as WorkspaceRecord;
  }
}

function envFor(kv: RacyKv): Env {
  return { REGISTRY: kv } as unknown as Env;
}

describe("workspaceRecordVersion", () => {
  it("treats a record written before versioning as version 0", () => {
    expect(workspaceRecordVersion(BASE)).toBe(0);
    expect(workspaceRecordVersion({ ...BASE, version: 7 })).toBe(7);
  });

  it("ignores a non-integer version rather than trusting hand-edited JSON", () => {
    expect(workspaceRecordVersion({ ...BASE, version: 1.5 as number })).toBe(0);
    expect(workspaceRecordVersion({ ...BASE, version: "3" as unknown as number })).toBe(0);
  });
});

describe("mutateWorkspaceRecord", () => {
  it("reads fresh, applies the mutation, and stamps version 1 on a legacy record", async () => {
    const kv = new RacyKv({ "ws:acme": BASE });
    const result = await mutateWorkspaceRecord(envFor(kv), "acme", (record) => ({
      ...record,
      maxStorageBytes: 5,
    }));

    expect(result.maxStorageBytes).toBe(5);
    expect(result.version).toBe(1);
    expect(kv.read("acme")).toMatchObject({ maxStorageBytes: 5, version: 1, bucket: "b" });
  });

  it("increments an existing version", async () => {
    const kv = new RacyKv({ "ws:acme": { ...BASE, version: 4 } });
    await mutateWorkspaceRecord(envFor(kv), "acme", (record) => ({ ...record, plan: "pro" }));
    expect(kv.read("acme").version).toBe(5);
  });

  it("mutates the freshest record, not a snapshot the caller read earlier", async () => {
    // The caller's stale view has no plan; another admin set one before the
    // mutation ran. The mutation must be applied on top of the newer record.
    const kv = new RacyKv({ "ws:acme": { ...BASE, version: 1, plan: "pro" } });
    await mutateWorkspaceRecord(envFor(kv), "acme", (record) => ({
      ...record,
      maxStorageBytes: 9,
    }));
    expect(kv.read("acme")).toMatchObject({ plan: "pro", maxStorageBytes: 9, version: 2 });
  });

  it("re-applies the mutation when another writer clobbers our put", async () => {
    const kv = new RacyKv({ "ws:acme": { ...BASE, version: 1 } });
    // Land a competing write (plan: pro) between our put and the verification
    // read of the first attempt — the classic lost update.
    kv.beforeGet = (gets) => {
      if (gets !== 2) return;
      kv.store.set("ws:acme", JSON.stringify({ ...BASE, version: 2, plan: "pro" }));
    };

    const result = await mutateWorkspaceRecord(envFor(kv), "acme", (record) => ({
      ...record,
      maxStorageBytes: 3,
    }));

    // The second attempt reads the competitor's record and layers our change
    // on top of it: neither update is lost.
    expect(result).toMatchObject({ plan: "pro", maxStorageBytes: 3, version: 3 });
    expect(kv.read("acme")).toMatchObject({ plan: "pro", maxStorageBytes: 3, version: 3 });
    expect(kv.puts).toBe(2);
  });

  it("409s after the attempt budget when every write keeps losing", async () => {
    const kv = new RacyKv({ "ws:acme": { ...BASE, version: 1 } });
    let competing = 100;
    kv.beforeGet = (gets) => {
      // Clobber before every verification read (every second get).
      if (gets % 2 === 0)
        kv.store.set("ws:acme", JSON.stringify({ ...BASE, version: competing++ }));
    };

    await expect(
      mutateWorkspaceRecord(envFor(kv), "acme", (record) => ({ ...record, maxStorageBytes: 3 })),
    ).rejects.toMatchObject({ status: 409, code: "workspace_record_conflict" });
    expect(kv.puts).toBe(WORKSPACE_MUTATION_ATTEMPTS);
  });

  it("skips the write when the mutation returns null", async () => {
    const kv = new RacyKv({ "ws:acme": { ...BASE, version: 2 } });
    const result = await mutateWorkspaceRecord(envFor(kv), "acme", () => null);
    expect(result.version).toBe(2);
    expect(kv.puts).toBe(0);
  });

  it("propagates a guard the mutation throws without writing", async () => {
    const kv = new RacyKv({ "ws:acme": { ...BASE, deletedAt: "2026-01-01T00:00:00.000Z" } });
    await expect(
      mutateWorkspaceRecord(envFor(kv), "acme", (record) => {
        if (record.deletedAt) {
          throw new AppError({
            type: "conflict",
            code: "already_deleted",
            message: "already deleted",
            status: 409,
          });
        }
        return record;
      }),
    ).rejects.toMatchObject({ code: "already_deleted" });
    expect(kv.puts).toBe(0);
  });

  it("404s for an unknown workspace", async () => {
    const kv = new RacyKv();
    await expect(
      mutateWorkspaceRecord(envFor(kv), "ghost", (record) => record),
    ).rejects.toMatchObject({ status: 404, code: "workspace_not_found" });
  });

  it("404s for a purged tombstone rather than resurrecting the slug", async () => {
    const kv = new RacyKv({
      "ws:gone": { status: "purged", name: "gone", purgedAt: "2026-01-01T00:00:00.000Z" },
    });
    await expect(
      mutateWorkspaceRecord(envFor(kv), "gone", (record) => record),
    ).rejects.toMatchObject({ status: 404 });
    expect(kv.puts).toBe(0);
  });

  it("404s a soft-deleted record only when the caller asks for a serving record", async () => {
    const kv = new RacyKv({ "ws:acme": { ...BASE, deletedAt: "2026-01-01T00:00:00.000Z" } });
    await expect(
      mutateWorkspaceRecord(envFor(kv), "acme", (record) => record, { requireServing: true }),
    ).rejects.toMatchObject({ status: 404, code: "workspace_not_found" });

    // Without the flag a soft-deleted record is mutable — that's how restore works.
    const restored = await mutateWorkspaceRecord(
      envFor(kv),
      "acme",
      ({ deletedAt: _, ...rest }) => rest,
    );
    expect(restored.deletedAt).toBeUndefined();
  });
});
