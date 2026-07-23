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
      plan: "free",
      allowedKeyPrefixes: ["f", "screenshots", "gh"],
      maxKeyDepth: 8,
    });
    expect(record.tokens).toBeUndefined(); // tokens are minted via POST /v1/tokens, never seeded
  });

  it("does not stamp explicit per-limit fields (issue #412/#454) — plan drives resolution", () => {
    const record = selfServeWorkspaceRecord({
      name: "zachbot",
      userId: "u1",
      now: new Date("2026-07-14T00:00:00Z"),
    });
    expect(record).not.toHaveProperty("maxStorageBytes");
    expect(record).not.toHaveProperty("maxUploadsPerPeriod");
    expect(record).not.toHaveProperty("maxUploadBytes");
    expect(record).not.toHaveProperty("maxVideoUploadBytes");
  });
  it("returns a fresh allowedKeyPrefixes array per call", () => {
    const a = selfServeWorkspaceRecord({ name: "a", userId: "u", now: new Date(0) });
    const b = selfServeWorkspaceRecord({ name: "b", userId: "u", now: new Date(0) });
    expect(a.allowedKeyPrefixes).not.toBe(b.allowedKeyPrefixes);
  });
  it("budget fields match PLANS.free.defaultLimits (single source of truth)", () => {
    const { maxMembers: _maxMembers, ...budgetDefaults } = PLANS.free.defaultLimits;
    expect({
      maxStorageBytes: SELF_SERVE_LIMITS.maxStorageBytes,
      maxUploadsPerPeriod: SELF_SERVE_LIMITS.maxUploadsPerPeriod,
      maxUploadBytes: SELF_SERVE_LIMITS.maxUploadBytes,
      maxVideoUploadBytes: SELF_SERVE_LIMITS.maxVideoUploadBytes,
    }).toEqual(budgetDefaults);
  });

  it("does not stamp maxMembers onto the record (issue #450)", () => {
    // The member cap must stay a plan default, not a per-record override:
    // stamping free's 3 here would outlive an upgrade to Pro, since an
    // explicit override beats a plan default in resolveMemberCap.
    expect(SELF_SERVE_LIMITS).not.toHaveProperty("maxMembers");
    const record = selfServeWorkspaceRecord({
      name: "acme",
      userId: "user_1",
      now: new Date("2026-07-23T00:00:00.000Z"),
    });
    expect(record).not.toHaveProperty("maxMembers");
  });
});
