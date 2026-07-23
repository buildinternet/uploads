import { describe, expect, it } from "vitest";
import { fakeRegistry } from "./fake-kv";
import { backfillSelfServePlans } from "../src/self-serve-plan-backfill";
import type { WorkspaceRecord } from "../src/workspace";

function envFor(records: Record<string, unknown>) {
  const registry = fakeRegistry(records);
  const env = { REGISTRY: registry } as unknown as Env;
  return { env, store: registry.store };
}

describe("backfillSelfServePlans", () => {
  it("sets plan free and clears stale free-default overrides on a pre-#412 self-serve record", async () => {
    const { env, store } = envFor({
      zachbot: {
        provider: "r2",
        bucket: "uploads-default",
        prefix: "zachbot/",
        selfServe: true,
        maxStorageBytes: 250_000_000,
        maxUploadsPerPeriod: 3000,
        maxUploadBytes: 25_000_000,
        maxVideoUploadBytes: 8_000_000,
      } satisfies WorkspaceRecord,
    });

    const result = await backfillSelfServePlans(env);
    expect(result.scanned).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);

    const stored = JSON.parse(store.get("ws:zachbot")!) as WorkspaceRecord;
    expect(stored.plan).toBe("free");
    expect(stored).not.toHaveProperty("maxStorageBytes");
    expect(stored).not.toHaveProperty("maxUploadsPerPeriod");
    expect(stored).not.toHaveProperty("maxUploadBytes");
    expect(stored).not.toHaveProperty("maxVideoUploadBytes");
  });

  it("dry-run reports would_update without writing", async () => {
    const { env, store } = envFor({
      zachbot: {
        provider: "r2",
        bucket: "uploads-default",
        selfServe: true,
        maxStorageBytes: 250_000_000,
      } satisfies WorkspaceRecord,
    });

    const result = await backfillSelfServePlans(env, { dryRun: true });
    expect(result.updated).toBe(1);
    expect(result.workspaces[0]).toMatchObject({ workspace: "zachbot", action: "would_update" });
    // unchanged in storage
    expect(JSON.parse(store.get("ws:zachbot")!).plan).toBeUndefined();
    expect(JSON.parse(store.get("ws:zachbot")!).maxStorageBytes).toBe(250_000_000);
  });

  it("preserves a genuinely custom override that doesn't match free's default", async () => {
    const { env, store } = envFor({
      acme: {
        provider: "r2",
        bucket: "uploads-default",
        selfServe: true,
        maxStorageBytes: 999_000_000, // comped — not a free default
        maxUploadsPerPeriod: 3000, // matches free default — cleared
      } satisfies WorkspaceRecord,
    });

    const result = await backfillSelfServePlans(env);
    expect(result.updated).toBe(1);
    const stored = JSON.parse(store.get("ws:acme")!) as WorkspaceRecord;
    expect(stored.plan).toBe("free");
    expect(stored.maxStorageBytes).toBe(999_000_000);
    expect(stored).not.toHaveProperty("maxUploadsPerPeriod");
  });

  it("skips a record that already has a plan set and no stale overrides", async () => {
    const { env, store } = envFor({
      already: {
        provider: "r2",
        bucket: "uploads-default",
        selfServe: true,
        plan: "pro",
      } satisfies WorkspaceRecord,
    });

    const result = await backfillSelfServePlans(env);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.workspaces[0]).toMatchObject({
      workspace: "already",
      action: "skipped",
      reason: "already_backfilled",
    });
    expect(JSON.parse(store.get("ws:already")!).plan).toBe("pro");
  });

  it("never touches an admin-provisioned (non-self-serve) workspace", async () => {
    const { env, store } = envFor({
      operator: {
        provider: "r2",
        bucket: "other",
        maxStorageBytes: 250_000_000, // happens to match free's default, but must not be touched
      } satisfies WorkspaceRecord,
    });

    const result = await backfillSelfServePlans(env);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.workspaces[0]).toMatchObject({
      workspace: "operator",
      action: "skipped",
      reason: "not_self_serve",
    });
    const stored = JSON.parse(store.get("ws:operator")!) as WorkspaceRecord;
    expect(stored.plan).toBeUndefined();
    expect(stored.maxStorageBytes).toBe(250_000_000);
  });

  it("sets plan on a self-serve record with no plan and no matching override fields", async () => {
    const { env, store } = envFor({
      nooverrides: {
        provider: "r2",
        bucket: "uploads-default",
        selfServe: true,
      } satisfies WorkspaceRecord,
    });

    const result = await backfillSelfServePlans(env);
    expect(result.updated).toBe(1);
    expect(JSON.parse(store.get("ws:nooverrides")!).plan).toBe("free");
  });
});
