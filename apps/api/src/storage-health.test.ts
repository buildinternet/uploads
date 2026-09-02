import { describe, expect, it } from "vitest";
import { fakeRegistry } from "../test/fake-kv";
import {
  classifyStorageFailure,
  clearStorageHealthFields,
  noteStorageFailure,
  noteStorageSuccess,
  STORAGE_HEALTH_MESSAGES,
  storageHealth,
} from "./storage-health";
import { demoteActiveLane, promoteLane } from "./workspace-lanes";
import type { WorkspaceRecord } from "./workspace";
import { activeContentStampFromVerify, storageStatusResponse } from "./routes/workspace-storage";
import type { StorageVerifyResult } from "./storage-verify";

/** A BYO (HTTP-credential, no binding) active-lane record. */
function byoRecord(extra: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    provider: "r2",
    bucket: "acme-media",
    accountId: "a".repeat(32),
    accessKeyId: "enc:v1:key",
    secretAccessKey: "enc:v1:secret",
    storageLaneId: "lane_0000beef",
    ...extra,
  } as WorkspaceRecord;
}

/** A shared (platform binding) active-lane record. */
function sharedRecord(extra: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    provider: "r2",
    bucket: "uploads-shared",
    binding: "BUCKET",
    prefix: "acme/",
    ...extra,
  } as WorkspaceRecord;
}

function envWith(records: Record<string, unknown>): {
  env: Env;
  registry: ReturnType<typeof fakeRegistry>;
} {
  const registry = fakeRegistry(records);
  return { env: { REGISTRY: registry } as unknown as Env, registry };
}

/** Shapes files-sdk raises: a `code` string, sometimes an HTTP `status`. */
function filesError(code: string, status?: number): Error & { code: string; status?: number } {
  return Object.assign(new Error(code), { code, status });
}

describe("classifyStorageFailure", () => {
  it("maps rejected credentials to auth", () => {
    expect(classifyStorageFailure(filesError("Unauthorized"))).toBe("auth");
    expect(classifyStorageFailure(filesError("Forbidden"))).toBe("auth");
    expect(classifyStorageFailure(filesError("SomethingElse", 403))).toBe("auth");
  });

  it("maps a missing bucket to bucket_missing", () => {
    expect(classifyStorageFailure(filesError("NotFound"))).toBe("bucket_missing");
  });

  it("ignores failures a credential rotation could not fix", () => {
    expect(classifyStorageFailure(filesError("InternalError", 500))).toBeUndefined();
    expect(classifyStorageFailure(filesError("EntityTooLarge", 413))).toBeUndefined();
    expect(classifyStorageFailure(new Error("network"))).toBeUndefined();
    expect(classifyStorageFailure(undefined)).toBeUndefined();
  });

  it("leaves files-sdk's transport/outage code unflagged", () => {
    // files-sdk normalizes network blips, timeouts, and provider outages to a
    // single `Provider` code and retries them itself. Nothing in that shape
    // separates a dead bucket from a hiccup, so it must never tell a workspace
    // its credentials are broken.
    expect(classifyStorageFailure(filesError("Provider"))).toBeUndefined();
    expect(classifyStorageFailure(filesError("Provider", 503))).toBeUndefined();
    expect(
      classifyStorageFailure(
        Object.assign(filesError("Provider"), { cause: new Error("fetch failed") }),
      ),
    ).toBeUndefined();
    expect(
      classifyStorageFailure(Object.assign(filesError("Provider"), { aborted: true })),
    ).toBeUndefined();
  });

  it("still classifies auth when a Provider-coded error carries a 401/403", () => {
    expect(classifyStorageFailure(filesError("Provider", 401))).toBe("auth");
    expect(classifyStorageFailure(filesError("Provider", 403))).toBe("auth");
  });
});

describe("storageHealth", () => {
  it("reports healthy when nothing is flagged", () => {
    expect(storageHealth(byoRecord())).toEqual({ ok: true });
  });

  it("projects the plain-language sentence and the first-failure timestamp", () => {
    const health = storageHealth(
      byoRecord({ storageUnhealthyAt: "2026-08-24T10:00:00.000Z", storageUnhealthyCode: "auth" }),
    );
    expect(health).toEqual({
      ok: false,
      code: "auth",
      message: STORAGE_HEALTH_MESSAGES.auth,
      since: "2026-08-24T10:00:00.000Z",
    });
  });

  it("still reports unhealthy for an unrecognized code", () => {
    const health = storageHealth(
      byoRecord({ storageUnhealthyAt: "2026-08-24T10:00:00.000Z", storageUnhealthyCode: "wat" }),
    );
    expect(health.ok).toBe(false);
    expect(health.code).toBe("unreachable");
  });
});

describe("noteStorageFailure", () => {
  it("flags the active BYO lane on an auth failure", async () => {
    const { env, registry } = envWith({ acme: byoRecord() });
    await noteStorageFailure(env, "acme", byoRecord(), filesError("Unauthorized"));
    const stored = registry.record<WorkspaceRecord>("acme")!;
    expect(stored.storageUnhealthyCode).toBe("auth");
    expect(typeof stored.storageUnhealthyAt).toBe("string");
  });

  it("never flags a shared lane — a platform failure is not the workspace's to fix", async () => {
    const { env, registry } = envWith({ acme: sharedRecord() });
    await noteStorageFailure(env, "acme", sharedRecord(), filesError("Unauthorized"));
    expect(registry.puts).toHaveLength(0);
  });

  it("ignores failures that say nothing about credentials", async () => {
    const { env, registry } = envWith({ acme: byoRecord() });
    await noteStorageFailure(env, "acme", byoRecord(), filesError("InternalError", 500));
    expect(registry.puts).toHaveLength(0);
  });

  it("keeps the first failure timestamp and writes nothing when already flagged the same way", async () => {
    const flagged = byoRecord({
      storageUnhealthyAt: "2026-08-01T00:00:00.000Z",
      storageUnhealthyCode: "auth",
    });
    const { env, registry } = envWith({ acme: flagged });
    await noteStorageFailure(env, "acme", flagged, filesError("Unauthorized"));
    expect(registry.puts).toHaveLength(0);
    expect(registry.record<WorkspaceRecord>("acme")!.storageUnhealthyAt).toBe(
      "2026-08-01T00:00:00.000Z",
    );
  });

  it("updates the code without moving `since` when the failure kind changes", async () => {
    const flagged = byoRecord({
      storageUnhealthyAt: "2026-08-01T00:00:00.000Z",
      storageUnhealthyCode: "auth",
    });
    const { env, registry } = envWith({ acme: flagged });
    await noteStorageFailure(env, "acme", flagged, filesError("NotFound"));
    const stored = registry.record<WorkspaceRecord>("acme")!;
    expect(stored.storageUnhealthyCode).toBe("bucket_missing");
    expect(stored.storageUnhealthyAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("does not flag a lane the workspace has since switched away from", async () => {
    // The stored record moved on to another lane while the failing upload was
    // in flight — flagging now would describe the wrong lane.
    const { env, registry } = envWith({ acme: byoRecord({ storageLaneId: "lane_11111111" }) });
    await noteStorageFailure(env, "acme", byoRecord(), filesError("Unauthorized"));
    expect(registry.puts).toHaveLength(0);
  });

  it("never throws when the workspace record is gone", async () => {
    const { env } = envWith({});
    await expect(
      noteStorageFailure(env, "acme", byoRecord(), filesError("Unauthorized")),
    ).resolves.toBeUndefined();
  });
});

describe("noteStorageSuccess", () => {
  it("clears the flag after a write lands again", async () => {
    const flagged = byoRecord({
      storageUnhealthyAt: "2026-08-01T00:00:00.000Z",
      storageUnhealthyCode: "auth",
    });
    const { env, registry } = envWith({ acme: flagged });
    await noteStorageSuccess(env, "acme", flagged);
    const stored = registry.record<WorkspaceRecord>("acme")!;
    expect(stored.storageUnhealthyAt).toBeUndefined();
    expect(stored.storageUnhealthyCode).toBeUndefined();
  });

  it("costs no KV write on a healthy workspace", async () => {
    const { env, registry } = envWith({ acme: byoRecord() });
    await noteStorageSuccess(env, "acme", byoRecord());
    expect(registry.puts).toHaveLength(0);
  });
});

describe("lane transitions carry health", () => {
  it("demoting a flagged active lane keeps it flagged in the lane list", () => {
    const record = byoRecord({
      storageUnhealthyAt: "2026-08-01T00:00:00.000Z",
      storageUnhealthyCode: "auth",
    });
    const lane = demoteActiveLane(record, "2026-08-24T00:00:00.000Z");
    expect(lane.unhealthyAt).toBe("2026-08-01T00:00:00.000Z");
    expect(lane.unhealthyCode).toBe("auth");
  });

  it("promoting a lane clears the active-lane flag", () => {
    const next = byoRecord({
      storageUnhealthyAt: "2026-08-01T00:00:00.000Z",
      storageUnhealthyCode: "auth",
    });
    promoteLane(
      next,
      { provider: "r2", bucket: "uploads-shared", binding: "BUCKET", prefix: "acme/" },
      undefined,
      undefined,
    );
    expect(next.storageUnhealthyAt).toBeUndefined();
    expect(next.storageUnhealthyCode).toBeUndefined();
  });

  it("clearStorageHealthFields removes both fields", () => {
    const next = byoRecord({ storageUnhealthyAt: "x", storageUnhealthyCode: "auth" });
    clearStorageHealthFields(next);
    expect(next.storageUnhealthyAt).toBeUndefined();
    expect(next.storageUnhealthyCode).toBeUndefined();
  });
});

describe("storageStatusResponse health projection", () => {
  it("reports the unhealthy active lane", () => {
    const response = storageStatusResponse(
      byoRecord({ storageUnhealthyAt: "2026-08-01T00:00:00.000Z", storageUnhealthyCode: "auth" }),
      true,
    );
    expect(response.health).toEqual({
      ok: false,
      code: "auth",
      message: STORAGE_HEALTH_MESSAGES.auth,
      since: "2026-08-01T00:00:00.000Z",
    });
  });

  it("always reports healthy in shared mode", () => {
    const response = storageStatusResponse(
      sharedRecord({ storageUnhealthyAt: "2026-08-01T00:00:00.000Z" }),
      true,
    );
    expect(response.health).toEqual({ ok: true });
  });

  it("surfaces a demoted lane's flag in the lane list", () => {
    const response = storageStatusResponse(
      sharedRecord({
        storageLanes: [
          {
            id: "lane_0000beef",
            provider: "r2",
            bucket: "acme-media",
            accountId: "a".repeat(32),
            accessKeyId: "enc:v1:key",
            secretAccessKey: "enc:v1:secret",
            lastActiveAt: "2026-08-24T00:00:00.000Z",
            unhealthyAt: "2026-08-01T00:00:00.000Z",
            unhealthyCode: "auth",
          },
        ],
      }),
      true,
    );
    expect(response.lanes[0]?.unhealthyAt).toBe("2026-08-01T00:00:00.000Z");
    // The normalized block too — a client showing "this fallback is broken"
    // must be able to say *what* broke, not just that something did.
    expect(response.lanes[0]?.health).toEqual({
      ok: false,
      code: "auth",
      message: STORAGE_HEALTH_MESSAGES.auth,
      since: "2026-08-01T00:00:00.000Z",
    });
  });

  it("normalizes an unrecognized stored code on a demoted lane", () => {
    const response = storageStatusResponse(
      sharedRecord({
        storageLanes: [
          {
            id: "lane_0000beef",
            provider: "r2",
            bucket: "acme-media",
            accountId: "a".repeat(32),
            accessKeyId: "enc:v1:key",
            secretAccessKey: "enc:v1:secret",
            lastActiveAt: "2026-08-24T00:00:00.000Z",
            unhealthyAt: "2026-08-01T00:00:00.000Z",
            unhealthyCode: "wat",
          },
        ],
      }),
      true,
    );
    expect(response.lanes[0]?.health).toMatchObject({
      ok: false,
      code: "unreachable",
      message: STORAGE_HEALTH_MESSAGES.unreachable,
    });
  });

  it("omits `health` entirely on a healthy lane", () => {
    const response = storageStatusResponse(
      sharedRecord({
        storageLanes: [
          {
            id: "lane_0000beef",
            provider: "r2",
            bucket: "acme-media",
            accountId: "a".repeat(32),
            accessKeyId: "enc:v1:key",
            secretAccessKey: "enc:v1:secret",
          },
        ],
      }),
      true,
    );
    expect(response.lanes[0]).not.toHaveProperty("health");
  });
});

describe("storageStatusResponse — active-content stamp (issue #929)", () => {
  it("projects the active lane's storageActiveContentVerifiedAt", () => {
    const response = storageStatusResponse(
      byoRecord({ storageActiveContentVerifiedAt: "2026-09-01T00:00:00.000Z" }),
      true,
    );
    expect(response.activeContentVerifiedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("omits the active-content stamp when the active lane has never passed the probe", () => {
    const response = storageStatusResponse(byoRecord(), true);
    expect(response.activeContentVerifiedAt).toBeUndefined();
  });

  it("projects a saved lane's own activeContentVerifiedAt in the lanes list", () => {
    const response = storageStatusResponse(
      sharedRecord({
        storageLanes: [
          {
            id: "lane_0000beef",
            provider: "r2",
            bucket: "acme-media",
            accountId: "a".repeat(32),
            accessKeyId: "enc:v1:key",
            secretAccessKey: "enc:v1:secret",
            activeContentVerifiedAt: "2026-08-20T00:00:00.000Z",
          },
        ],
      }),
      true,
    );
    expect(response.lanes[0]?.activeContentVerifiedAt).toBe("2026-08-20T00:00:00.000Z");
  });
});

describe("activeContentStampFromVerify (issue #929)", () => {
  const nowIso = "2026-09-02T00:00:00.000Z";

  it("returns nowIso when the active-content-headers check passed", () => {
    const result: StorageVerifyResult = {
      ok: true,
      checks: [{ id: "active-content-headers", ok: true, required: false }],
    };
    expect(activeContentStampFromVerify(result, nowIso)).toBe(nowIso);
  });

  it("returns undefined when the active-content-headers check failed", () => {
    const result: StorageVerifyResult = {
      ok: true,
      checks: [{ id: "active-content-headers", ok: false, required: false, hint: "missing csp" }],
    };
    expect(activeContentStampFromVerify(result, nowIso)).toBeUndefined();
  });

  it("returns undefined when the check never ran (no publicBaseUrl, or the public-url check failed)", () => {
    const result: StorageVerifyResult = {
      ok: true,
      checks: [{ id: "public-url", ok: false, required: false, hint: "no public base URL" }],
    };
    expect(activeContentStampFromVerify(result, nowIso)).toBeUndefined();
  });
});
