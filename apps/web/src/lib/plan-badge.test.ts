import { describe, expect, it } from "vitest";
import { shouldShowProBadge } from "./plan-badge";

describe("shouldShowProBadge", () => {
  it("shows the badge only for a literal pro plan", () => {
    expect(shouldShowProBadge("pro")).toBe(true);
  });

  it("hides the badge for free workspaces", () => {
    expect(shouldShowProBadge("free")).toBe(false);
  });

  it("hides the badge for legacy/unapplied plans (undefined)", () => {
    expect(shouldShowProBadge(undefined)).toBe(false);
  });

  it("hides the badge for any other/unknown plan id", () => {
    expect(shouldShowProBadge("enterprise")).toBe(false);
  });
});
