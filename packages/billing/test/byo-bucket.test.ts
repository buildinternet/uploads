import { describe, expect, it } from "vitest";
import { planAllowsByoBucket } from "../src/byo-bucket";
import { PLANS } from "../src/plans";

describe("planAllowsByoBucket (#583 Task 1.3 — dark plan capability)", () => {
  it("ships true on every plan today (dark — nothing enforces it yet)", () => {
    expect(PLANS.free.byoBucket).toBe(true);
    expect(PLANS.pro.byoBucket).toBe(true);
  });

  it("is true for a workspace explicitly on free or pro", () => {
    expect(planAllowsByoBucket({ plan: "free" })).toBe(true);
    expect(planAllowsByoBucket({ plan: "pro" })).toBe(true);
  });

  it("fails open to free's (also true) capability for an unrecognized/absent plan", () => {
    expect(planAllowsByoBucket({ plan: "enterprise" })).toBe(true);
    expect(planAllowsByoBucket({})).toBe(true);
  });
});
