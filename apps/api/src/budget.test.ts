import { describe, expect, it } from "vitest";
import {
  checkPutBudget,
  enforcedMaxStorageBytes,
  resolveBudgetLimits,
  storageBudgetApplies,
  usageWithLimits,
} from "./budget";
import type { WorkspaceUsage } from "./usage";

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
      maxStorageBytes: 10_000_000_000,
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

describe("storageBudgetApplies (#583 Task 1.2 — BYO storage-ownership signal)", () => {
  it("applies to a plain shared-bucket record (no creds, no binding)", () => {
    expect(storageBudgetApplies({})).toBe(true);
  });

  it("applies to a binding-mode dedicated-bucket record, even with stray credential fields", () => {
    expect(
      storageBudgetApplies({
        binding: "UPLOADS_DEFAULT",
        accountId: "a".repeat(32),
        accessKeyId: "key",
        secretAccessKey: "secret",
      }),
    ).toBe(true);
  });

  it("does not apply to an HTTP-credential BYO record (no binding, full cred triple)", () => {
    expect(
      storageBudgetApplies({
        accountId: "a".repeat(32),
        accessKeyId: "key",
        secretAccessKey: "secret",
      }),
    ).toBe(false);
  });

  it("applies when the credential triple is incomplete (not really BYO yet)", () => {
    expect(storageBudgetApplies({ accountId: "a".repeat(32), accessKeyId: "key" })).toBe(true);
  });
});

describe("checkPutBudget — storage cap skipped for BYO, upload cap unaffected", () => {
  const usage: WorkspaceUsage = {
    workspace: "acme",
    bytes: 900,
    objects: 1,
    sharedBytes: 900,
    sharedObjects: 1,
    uploadsInPeriod: 2,
    periodStart: "2026-07",
    updatedAt: "2026-07-31T00:00:00.000Z",
  };

  const byoLimits = {
    maxStorageBytes: 1_000,
    maxUploadsPerPeriod: 3,
    accountId: "a".repeat(32),
    accessKeyId: "key",
    secretAccessKey: "secret",
  };

  it("denies a storage-exceeding put on a shared-bucket workspace", () => {
    const denial = checkPutBudget(usage, { maxStorageBytes: 1_000 }, { bytes: 200, uploads: 1 });
    expect(denial?.code).toBe("storage_quota_exceeded");
  });

  it("allows the same put on a BYO workspace when shared residue stays under cap", () => {
    const denial = checkPutBudget(usage, byoLimits, { bytes: 200, uploads: 1 });
    expect(denial).toBeNull();
  });

  it("still enforces maxUploadsPerPeriod on a BYO workspace", () => {
    const denial = checkPutBudget({ ...usage, uploadsInPeriod: 3 }, byoLimits, {
      bytes: 0,
      uploads: 1,
    });
    expect(denial?.code).toBe("upload_budget_exceeded");
  });
});

describe("enforcedMaxStorageBytes", () => {
  it("returns the cap for a BYO record so shared residue remains enforced", () => {
    expect(
      enforcedMaxStorageBytes({
        maxStorageBytes: 1_000,
        accountId: "a".repeat(32),
        accessKeyId: "key",
        secretAccessKey: "secret",
      }),
    ).toBe(1_000);
  });

  it("returns the plan cap for a plain shared-bucket record", () => {
    expect(enforcedMaxStorageBytes({ plan: "free" })).toBe(250_000_000);
  });
});

describe("usageWithLimits — storage fields use the active lane's budget attribution", () => {
  const usage: WorkspaceUsage = {
    workspace: "acme",
    bytes: 900,
    objects: 1,
    sharedBytes: 900,
    sharedObjects: 1,
    uploadsInPeriod: 2,
    periodStart: "2026-07",
    updatedAt: "2026-07-31T00:00:00.000Z",
  };

  it("reports remaining shared residue for a BYO record", () => {
    const out = usageWithLimits(usage, {
      maxStorageBytes: 1_000,
      accountId: "a".repeat(32),
      accessKeyId: "key",
      secretAccessKey: "secret",
    });
    expect(out.maxStorageBytes).toBe(1_000);
    expect(out.storageRemainingBytes).toBe(100);
    expect(out.storageBudgetBasis).toBe("shared");
  });

  it("includes maxStorageBytes/storageRemainingBytes for a shared-bucket record", () => {
    const out = usageWithLimits(usage, { maxStorageBytes: 1_000 });
    expect(out.maxStorageBytes).toBe(1_000);
    expect(out.storageRemainingBytes).toBe(100);
    expect(out.storageBudgetBasis).toBe("total");
  });
});
