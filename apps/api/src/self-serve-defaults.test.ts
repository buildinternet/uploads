import { describe, expect, it } from "vitest";
import { PLANS } from "@uploads/billing";
import { selfServeWorkspaceRecord, SELF_SERVE_LIMITS } from "./self-serve-defaults";

describe("selfServeWorkspaceRecord", () => {
  it("builds a shared-bucket prefixed record with self-serve limits", () => {
    const record = selfServeWorkspaceRecord({
      name: "zachbot",
      userId: "u1",
      now: new Date("2026-07-14T00:00:00Z"),
    });
    expect(record).toMatchObject({
      name: "zachbot",
      provider: "r2",
      bucket: "uploads-default",
      binding: "UPLOADS_DEFAULT",
      prefix: "zachbot/",
      publicBaseUrl: "https://storage.uploads.sh",
      selfServe: true,
      createdByUserId: "u1",
      createdAt: "2026-07-14T00:00:00.000Z",
      maxStorageBytes: PLANS.free.defaultLimits.maxStorageBytes,
      maxUploadsPerPeriod: PLANS.free.defaultLimits.maxUploadsPerPeriod,
      maxUploadBytes: PLANS.free.defaultLimits.maxUploadBytes,
      maxVideoUploadBytes: PLANS.free.defaultLimits.maxVideoUploadBytes,
      allowedKeyPrefixes: ["f", "screenshots", "gh"],
      maxKeyDepth: 8,
    });
    expect(record.tokens).toBeUndefined(); // tokens are minted via POST /v1/tokens, never seeded
  });
  it("returns a fresh allowedKeyPrefixes array per call", () => {
    const a = selfServeWorkspaceRecord({ name: "a", userId: "u", now: new Date(0) });
    const b = selfServeWorkspaceRecord({ name: "b", userId: "u", now: new Date(0) });
    expect(a.allowedKeyPrefixes).not.toBe(b.allowedKeyPrefixes);
  });
  it("budget fields match PLANS.free.defaultLimits (single source of truth)", () => {
    expect({
      maxStorageBytes: SELF_SERVE_LIMITS.maxStorageBytes,
      maxUploadsPerPeriod: SELF_SERVE_LIMITS.maxUploadsPerPeriod,
      maxUploadBytes: SELF_SERVE_LIMITS.maxUploadBytes,
      maxVideoUploadBytes: SELF_SERVE_LIMITS.maxVideoUploadBytes,
    }).toEqual(PLANS.free.defaultLimits);
  });
});
