import { describe, expect, it } from "vitest";
import { resolveBudgetLimits } from "./budget";

describe("resolveBudgetLimits — plan-aware resolution", () => {
  // Controller ruling (post-BLOCKED review): plan defaults apply ONLY when
  // `plan` is explicitly set on the record. Absent `plan` must reproduce
  // today's (pre-billing) behavior byte-for-byte — legacy/admin-provisioned
  // workspaces stay unlimited, matching production today.
  it("no plan set: legacy unlimited behavior, unchanged (regression guard)", () => {
    expect(resolveBudgetLimits({})).toEqual({
      maxStorageBytes: undefined,
      maxUploadsPerPeriod: undefined,
    });
  });

  it("an explicit maxStorageBytes override still applies with no plan set (existing PR #280 behavior)", () => {
    expect(resolveBudgetLimits({ maxStorageBytes: 500 })).toEqual({
      maxStorageBytes: 500,
      maxUploadsPerPeriod: undefined,
    });
  });

  it("a workspace explicitly on the free plan resolves free's defaults", () => {
    expect(resolveBudgetLimits({ plan: "free" })).toEqual({
      maxStorageBytes: 250_000_000,
      maxUploadsPerPeriod: 3000,
    });
  });

  it("a workspace explicitly on the pro plan resolves pro's defaults", () => {
    expect(resolveBudgetLimits({ plan: "pro" })).toEqual({
      maxStorageBytes: 25_000_000_000,
      maxUploadsPerPeriod: 100_000,
    });
  });

  it("an unknown/legacy plan string fails open to free's defaults", () => {
    expect(resolveBudgetLimits({ plan: "enterprise" })).toEqual({
      maxStorageBytes: 250_000_000,
      maxUploadsPerPeriod: 3000,
    });
  });

  it("plan set + a zero/negative/non-finite override is treated as unset, falling back to the plan default (unchanged positiveLimit behavior)", () => {
    expect(resolveBudgetLimits({ plan: "free", maxStorageBytes: 0 })).toEqual({
      maxStorageBytes: 250_000_000,
      maxUploadsPerPeriod: 3000,
    });
  });

  it("plan set + an explicit numeric override still beats the plan default", () => {
    expect(resolveBudgetLimits({ plan: "pro", maxStorageBytes: 1_000 })).toEqual({
      maxStorageBytes: 1_000,
      maxUploadsPerPeriod: 100_000,
    });
  });
});
