import { describe, expect, it } from "vitest";
import { memberCapMessage, resolveMemberCap } from "../src/member-cap";
import { PLANS } from "../src/plans";

describe("resolveMemberCap — scope rule", () => {
  it("caps a workspace explicitly on free at the plan default", () => {
    expect(resolveMemberCap({ plan: "free" })).toBe(PLANS.free.defaultLimits.maxMembers);
  });

  it("caps a self-serve workspace with no plan stamped (the common free case)", () => {
    expect(resolveMemberCap({ selfServe: true })).toBe(3);
  });

  it("leaves a legacy operator-provisioned workspace unlimited", () => {
    expect(resolveMemberCap({})).toBeNull();
    expect(resolveMemberCap({ selfServe: false })).toBeNull();
  });

  it("applies pro's unmarketed abuse guard on pro", () => {
    expect(resolveMemberCap({ plan: "pro" })).toBe(25);
  });

  it("fails open to free's cap for an unrecognized plan string", () => {
    expect(resolveMemberCap({ plan: "enterprise" })).toBe(3);
  });
});

describe("resolveMemberCap — override precedence", () => {
  it("an explicit numeric override beats the plan default", () => {
    expect(resolveMemberCap({ plan: "free", maxMembers: 10 })).toBe(10);
  });

  it("an explicit null override means unlimited, even on free", () => {
    expect(resolveMemberCap({ plan: "free", maxMembers: null })).toBeNull();
  });

  it("an override applies to a legacy workspace that has no plan at all", () => {
    expect(resolveMemberCap({ maxMembers: 5 })).toBe(5);
  });

  it("treats a zero/negative/non-finite override as unlimited rather than a lockout", () => {
    expect(resolveMemberCap({ plan: "free", maxMembers: 0 })).toBeNull();
    expect(resolveMemberCap({ plan: "free", maxMembers: -1 })).toBeNull();
    expect(resolveMemberCap({ plan: "free", maxMembers: Number.NaN })).toBeNull();
  });
});

describe("memberCapMessage", () => {
  it("nudges toward Pro when the workspace is on free", () => {
    expect(memberCapMessage(3, { plan: "free" })).toBe(
      "Free workspaces include 3 members — upgrade to Pro for more.",
    );
    expect(memberCapMessage(3, { selfServe: true })).toContain("upgrade to Pro");
  });

  it("does not upsell a workspace already on pro", () => {
    expect(memberCapMessage(25, { plan: "pro" })).toBe("This workspace includes 25 members.");
  });

  it("does not upsell a comped override, and states the real number", () => {
    expect(memberCapMessage(10, { plan: "free", maxMembers: 10 })).toBe(
      "This workspace includes 10 members.",
    );
  });

  it("agrees in number for a cap of one", () => {
    expect(memberCapMessage(1, { plan: "free", maxMembers: 1 })).toContain("1 member.");
  });
});
