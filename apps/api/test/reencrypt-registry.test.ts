import { describe, expect, it } from "vitest";
import { fakeRegistry } from "./fake-kv";
import { encryptSecret } from "../src/secrets";
import { reencryptRegistryCredentials } from "../src/reencrypt-registry";
import type { StorageLane, WorkspaceRecord } from "../src/workspace";

const CURRENT = "current-master-secret!!";
const PREVIOUS = "previous-master-secret!";

describe("reencryptRegistryCredentials", () => {
  it("rewrites credentials sealed with the previous key", async () => {
    const sealedAk = await encryptSecret(PREVIOUS, "AKIA");
    const sealedSk = await encryptSecret(PREVIOUS, "secret");
    const registry = fakeRegistry({
      byo: {
        provider: "r2",
        bucket: "other",
        accessKeyId: sealedAk,
        secretAccessKey: sealedSk,
      } satisfies WorkspaceRecord,
      shared: {
        provider: "r2",
        bucket: "uploads-default",
        prefix: "shared/",
      } satisfies WorkspaceRecord,
    });
    const store = registry.store;

    const env = {
      WORKSPACE_SECRETS_KEY: CURRENT,
      WORKSPACE_SECRETS_KEY_PREVIOUS: PREVIOUS,
      REGISTRY: registry,
    } as unknown as Env;

    const dry = await reencryptRegistryCredentials(env, { dryRun: true });
    expect(dry.updated).toBe(1);
    expect(dry.workspaces.find((w) => w.workspace === "byo")?.action).toBe("would_update");
    // dry-run must not write
    expect(JSON.parse(store.get("ws:byo")!).accessKeyId).toBe(sealedAk);

    const live = await reencryptRegistryCredentials(env, { dryRun: false });
    expect(live.updated).toBe(1);
    const next = JSON.parse(store.get("ws:byo")!) as WorkspaceRecord;
    expect(next.accessKeyId).not.toBe(sealedAk);
    // Decrypt with current alone
    const { openCredentialFields } = await import("../src/secrets");
    const opened = await openCredentialFields(CURRENT, next);
    expect(opened.accessKeyId).toBe("AKIA");
    expect(opened.secretAccessKey).toBe("secret");
    expect(opened.usedPrevious).toBe(false);
  });

  it("reseals a fallback lane's credentials alongside the active pair", async () => {
    const laneSealedAk = await encryptSecret(PREVIOUS, "LANE_AKIA");
    const laneSealedSk = await encryptSecret(PREVIOUS, "lane-secret");
    const lane: StorageLane = {
      id: "lane_deadbeef",
      provider: "r2",
      bucket: "customer-bucket",
      lastActiveAt: "2026-08-01T00:00:00.000Z",
      accessKeyId: laneSealedAk,
      secretAccessKey: laneSealedSk,
    };
    const registry = fakeRegistry({
      "two-lane": {
        provider: "r2",
        bucket: "uploads-default",
        prefix: "two-lane/",
        storageLanes: [lane],
      } satisfies WorkspaceRecord,
    });
    const store = registry.store;

    const env = {
      WORKSPACE_SECRETS_KEY: CURRENT,
      WORKSPACE_SECRETS_KEY_PREVIOUS: PREVIOUS,
      REGISTRY: registry,
    } as unknown as Env;

    // No top-level credentials on this record — only the lane's. The sweep
    // must not skip it as "no_credentials".
    const dry = await reencryptRegistryCredentials(env, { dryRun: true });
    expect(dry.workspaces.find((w) => w.workspace === "two-lane")?.action).toBe("would_update");

    const live = await reencryptRegistryCredentials(env, { dryRun: false });
    expect(live.workspaces.find((w) => w.workspace === "two-lane")?.action).toBe("updated");

    const next = JSON.parse(store.get("ws:two-lane")!) as WorkspaceRecord;
    const nextLane = next.storageLanes?.[0];
    expect(nextLane?.id).toBe("lane_deadbeef");
    expect(nextLane?.accessKeyId).not.toBe(laneSealedAk);

    const { openCredentialFields } = await import("../src/secrets");
    const opened = await openCredentialFields(CURRENT, {
      accessKeyId: nextLane?.accessKeyId,
      secretAccessKey: nextLane?.secretAccessKey,
    });
    expect(opened.accessKeyId).toBe("LANE_AKIA");
    expect(opened.secretAccessKey).toBe("lane-secret");
    expect(opened.usedPrevious).toBe(false);
  });
});
