import { describe, expect, it } from "vitest";
import type { WorkspaceSummaryResult } from "./api-client";
import { storageFullBannerState } from "./storage-full-banner";

function summary(
  usage: Partial<NonNullable<Extract<WorkspaceSummaryResult, { kind: "success" }>["usage"]>>,
  role = "owner",
  plan: string | undefined = "free",
): WorkspaceSummaryResult {
  return {
    kind: "success",
    workspace: {
      workspace: "acme",
      organization: { id: "o", slug: "acme", name: "Acme" },
      role,
      hasPublicUrl: false,
      plan,
    },
    usage: { bytes: 0, objects: 0, uploadsInPeriod: 0, ...usage } as never,
  };
}

describe("storageFullBannerState", () => {
  it("stays hidden below the cap, with no cap, or without usage", () => {
    expect(
      storageFullBannerState(summary({ bytes: 249_999_999, maxStorageBytes: 250_000_000 })),
    ).toBeNull();
    expect(storageFullBannerState(summary({ bytes: 9e12 }))).toBeNull();
    expect(storageFullBannerState({ kind: "unavailable", reason: "server" })).toBeNull();
  });

  it("offers an upgrade and a bucket to admins on Free", () => {
    expect(
      storageFullBannerState(summary({ bytes: 250_000_000, maxStorageBytes: 250_000_000 })),
    ).toEqual({
      upgrade: true,
      bucket: true,
    });
  });

  it("drops the upgrade on Pro and both links for members", () => {
    const full = { bytes: 10_000_000_000, maxStorageBytes: 10_000_000_000 };
    expect(storageFullBannerState(summary(full, "admin", "pro"))).toEqual({
      upgrade: false,
      bucket: true,
    });
    expect(storageFullBannerState(summary(full, "member"))).toEqual({
      upgrade: false,
      bucket: false,
    });
  });

  it("meters only hosted bytes once a bucket is connected", () => {
    const byo = { bytes: 900_000_000, sharedBytes: 10_000_000, maxStorageBytes: 250_000_000 };
    expect(storageFullBannerState(summary({ ...byo, storageBudgetBasis: "shared" }))).toBeNull();
  });
});
