import { describe, expect, it } from "vitest";
import {
  countCapEligibleWorkspaces,
  MAX_SELF_SERVE_WORKSPACES,
  resolveWorkspaceCreateQuota,
  workspaceCapMessage,
  type WorkspaceCapRecord,
} from "../src/workspace-cap";

/** A free self-serve workspace — the only kind that burns a slot. */
const free: WorkspaceCapRecord = { selfServe: true };
/** Self-serve, later upgraded — exempt. */
const pro: WorkspaceCapRecord = { selfServe: true, plan: "pro" };
/** Operator-provisioned, no self-serve flag — exempt. */
const legacy: WorkspaceCapRecord = {};

describe("countCapEligibleWorkspaces", () => {
  it("counts free self-serve workspaces", () => {
    expect(countCapEligibleWorkspaces([free, free, free])).toBe(3);
  });

  it("exempts paid workspaces", () => {
    expect(countCapEligibleWorkspaces([free, free, pro])).toBe(2);
  });

  it("exempts legacy/operator-provisioned workspaces", () => {
    expect(countCapEligibleWorkspaces([legacy, legacy, free])).toBe(1);
  });

  it("counts a self-serve record with an explicit free plan", () => {
    expect(countCapEligibleWorkspaces([{ selfServe: true, plan: "free" }])).toBe(1);
  });

  it("counts a self-serve record with an unrecognized plan (fails open to free)", () => {
    expect(countCapEligibleWorkspaces([{ selfServe: true, plan: "enterprise" }])).toBe(1);
  });

  it("skips records that could not be loaded", () => {
    expect(countCapEligibleWorkspaces([free, null, undefined, free])).toBe(2);
  });

  it("counts nothing for a user who owns nothing", () => {
    expect(countCapEligibleWorkspaces([])).toBe(0);
  });
});

describe("resolveWorkspaceCreateQuota", () => {
  it("allows creation below the cap", () => {
    expect(resolveWorkspaceCreateQuota([free, free])).toEqual({
      used: 2,
      cap: MAX_SELF_SERVE_WORKSPACES,
      allowed: true,
    });
  });

  it("denies creation at the cap", () => {
    expect(resolveWorkspaceCreateQuota([free, free, free])).toEqual({
      used: 3,
      cap: MAX_SELF_SERVE_WORKSPACES,
      allowed: false,
    });
  });

  it("frees a slot when one workspace is on a paid plan", () => {
    expect(resolveWorkspaceCreateQuota([free, free, pro])).toEqual({
      used: 2,
      cap: MAX_SELF_SERVE_WORKSPACES,
      allowed: true,
    });
  });

  // A lapsed Pro leaves the user over the cap. Nothing is reclaimed — the cap
  // is a creation gate, so this reports honestly and simply denies creation.
  it("reports an over-cap count after a downgrade without throwing", () => {
    expect(resolveWorkspaceCreateQuota([free, free, free, free])).toEqual({
      used: 4,
      cap: MAX_SELF_SERVE_WORKSPACES,
      allowed: false,
    });
  });
});

describe("workspaceCapMessage", () => {
  it("names the cap in force and points at the upgrade path", () => {
    expect(workspaceCapMessage(MAX_SELF_SERVE_WORKSPACES)).toBe(
      "Free accounts include 3 workspaces. Upgrade one to Pro to create another.",
    );
  });

  it("reads naturally at a cap of one", () => {
    expect(workspaceCapMessage(1)).toContain("1 workspace.");
  });
});
