import { describe, expect, it } from "vitest";
import { planResponse, validatePlanPatch } from "./workspace-plan";

describe("validatePlanPatch", () => {
  it("accepts a known plan id", () => {
    expect(validatePlanPatch({ plan: "pro" })).toEqual({ plan: "pro" });
    expect(validatePlanPatch({ plan: "free" })).toEqual({ plan: "free" });
  });

  it("rejects an unknown plan id", () => {
    expect(() => validatePlanPatch({ plan: "enterprise" })).toThrow(/invalid_plan|plan/i);
  });

  it("rejects a missing plan field", () => {
    expect(() => validatePlanPatch({})).toThrow(/invalid_plan|plan/i);
  });

  it("rejects a non-object body", () => {
    expect(() => validatePlanPatch(null)).toThrow(/invalid_plan|plan/i);
    expect(() => validatePlanPatch("pro")).toThrow(/invalid_plan|plan/i);
  });
});

describe("planResponse", () => {
  it("reports the free plan, its resolved limits, and no overrides for a bare record", () => {
    const result = planResponse("acme", { provider: "r2", bucket: "b" });
    expect(result).toEqual({
      workspace: "acme",
      plan: "free",
      available: true,
      limits: {
        maxStorageBytes: 250_000_000,
        maxUploadsPerPeriod: 3000,
        maxUploadBytes: 25_000_000,
        maxVideoUploadBytes: 8_000_000,
      },
      overrides: [],
    });
  });

  it("lists explicit override fields and resolves them into limits", () => {
    const result = planResponse("acme", {
      provider: "r2",
      bucket: "b",
      maxStorageBytes: 999,
    });
    expect(result.overrides).toEqual(["maxStorageBytes"]);
    expect(result.limits.maxStorageBytes).toBe(999);
    expect(result.limits.maxUploadsPerPeriod).toBe(3000);
  });

  it("reports pro as unavailable when a workspace is set to it", () => {
    const result = planResponse("acme", { provider: "r2", bucket: "b", plan: "pro" });
    expect(result.plan).toBe("pro");
    expect(result.available).toBe(false);
  });

  it("fails open to free for an unrecognized stored plan string", () => {
    const result = planResponse("acme", {
      provider: "r2",
      bucket: "b",
      plan: "enterprise" as never,
    });
    expect(result.plan).toBe("free");
  });
});
