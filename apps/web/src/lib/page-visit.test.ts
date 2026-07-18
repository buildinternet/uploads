import { afterEach, describe, expect, it } from "vitest";
import {
  getPageVisit,
  isCurrentPageVisit,
  markPageLoad,
  resetPageVisitForTests,
} from "./page-visit";

afterEach(() => {
  resetPageVisitForTests();
});

describe("page visit generation", () => {
  it("starts at 0 and is not a current visit", () => {
    expect(getPageVisit()).toBe(0);
    expect(isCurrentPageVisit(0)).toBe(false);
  });

  it("marks prior visits stale after another page-load", () => {
    const first = markPageLoad();
    expect(first).toBe(1);
    expect(isCurrentPageVisit(first)).toBe(true);

    const second = markPageLoad();
    expect(second).toBe(2);
    expect(isCurrentPageVisit(first)).toBe(false);
    expect(isCurrentPageVisit(second)).toBe(true);
  });
});
