import { describe, expect, it } from "vitest";
import { checkPutBudget, resolveBudgetLimits, usageWithLimits } from "../src/budget";
import type { WorkspaceUsage } from "../src/usage";

const usage = (partial: Partial<WorkspaceUsage> = {}): WorkspaceUsage => ({
  workspace: "acme",
  bytes: 1000,
  objects: 2,
  uploadsInPeriod: 5,
  periodStart: "2026-07",
  updatedAt: "2026-07-11T00:00:00.000Z",
  ...partial,
});

describe("resolveBudgetLimits", () => {
  it("treats missing and non-positive as unlimited", () => {
    expect(resolveBudgetLimits({})).toEqual({
      maxStorageBytes: undefined,
      maxUploadsPerPeriod: undefined,
    });
    expect(resolveBudgetLimits({ maxStorageBytes: 0, maxUploadsPerPeriod: -1 })).toEqual({
      maxStorageBytes: undefined,
      maxUploadsPerPeriod: undefined,
    });
  });
});

describe("checkPutBudget", () => {
  it("allows puts when no limits are set", () => {
    expect(checkPutBudget(usage(), {}, { bytes: 9e15, uploads: 1 })).toBeNull();
  });

  it("denies when storage would exceed the cap", () => {
    const denial = checkPutBudget(
      usage({ bytes: 900 }),
      { maxStorageBytes: 1000 },
      {
        bytes: 200,
        uploads: 1,
      },
    );
    expect(denial?.code).toBe("storage_quota_exceeded");
    expect(denial?.status).toBe(507);
    expect(denial?.detail).toMatchObject({
      bytes: 900,
      deltaBytes: 200,
      maxStorageBytes: 1000,
    });
  });

  it("allows overwrites that shrink or stay under the cap", () => {
    expect(
      checkPutBudget(
        usage({ bytes: 1000 }),
        { maxStorageBytes: 1000 },
        { bytes: -100, uploads: 1 },
      ),
    ).toBeNull();
    expect(
      checkPutBudget(usage({ bytes: 900 }), { maxStorageBytes: 1000 }, { bytes: 100, uploads: 1 }),
    ).toBeNull();
  });

  it("denies when monthly upload budget is exhausted", () => {
    const denial = checkPutBudget(
      usage({ uploadsInPeriod: 10 }),
      { maxUploadsPerPeriod: 10 },
      { bytes: 1, uploads: 1 },
    );
    expect(denial?.code).toBe("upload_budget_exceeded");
    expect(denial?.status).toBe(429);
  });
});

describe("usageWithLimits", () => {
  it("includes remaining when caps are set", () => {
    expect(
      usageWithLimits(usage({ bytes: 400, uploadsInPeriod: 3 }), {
        maxStorageBytes: 1000,
        maxUploadsPerPeriod: 10,
      }),
    ).toMatchObject({
      bytes: 400,
      maxStorageBytes: 1000,
      storageRemainingBytes: 600,
      uploadsInPeriod: 3,
      maxUploadsPerPeriod: 10,
      uploadsRemaining: 7,
    });
  });

  it("omits limit fields when unlimited", () => {
    const snap = usageWithLimits(usage(), {});
    expect(snap).not.toHaveProperty("maxStorageBytes");
    expect(snap).not.toHaveProperty("maxUploadsPerPeriod");
  });
});
