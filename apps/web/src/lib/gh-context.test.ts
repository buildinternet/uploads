import { describe, it, expect } from "vitest";
import {
  ghWorkItemFromMetadata,
  connectedWork,
  exactPrMatch,
  githubUrl,
  applyGhTitles,
  type GhWorkItem,
} from "./gh-context";

const pr = {
  "gh.repo": "o/uploads",
  "gh.kind": "pull",
  "gh.number": "1789",
  "gh.ref": "o/uploads#1789",
};
const issue = {
  "gh.repo": "o/uploads",
  "gh.kind": "issue",
  "gh.number": "1740",
  "gh.ref": "o/uploads#1740",
};

describe("gh-context", () => {
  it("builds a work item with url + labels", () => {
    expect(ghWorkItemFromMetadata(pr)).toMatchObject({
      ref: "o/uploads#1789",
      kind: "pull",
      kindLabel: "pull request",
      url: "https://github.com/o/uploads/pull/1789",
    });
    expect(ghWorkItemFromMetadata(issue)!.url).toBe("https://github.com/o/uploads/issues/1740");
  });
  it("returns null when gh.* is absent/partial", () => {
    expect(ghWorkItemFromMetadata(undefined)).toBeNull();
    expect(ghWorkItemFromMetadata({ "gh.repo": "o/uploads" })).toBeNull();
  });
  it("uses gh.title as the label when present (issue #267)", () => {
    const item = ghWorkItemFromMetadata({ ...pr, "gh.title": "Fix the login bug" });
    expect(item!.label).toBe("Fix the login bug");
    expect(item!.ref).toBe("o/uploads#1789"); // ref stays the raw coordinate, unaffected
  });
  it("falls back to ref when gh.title is absent or empty (older files)", () => {
    expect(ghWorkItemFromMetadata(pr)!.label).toBe("o/uploads#1789");
    expect(ghWorkItemFromMetadata({ ...pr, "gh.title": "" })!.label).toBe("o/uploads#1789");
  });
  it("dedupes connected work by ref", () => {
    const items = connectedWork([
      { metadata: pr },
      { metadata: pr },
      { metadata: issue },
      { metadata: undefined },
    ]);
    expect(items.map((i) => i.ref)).toEqual(["o/uploads#1789", "o/uploads#1740"]);
  });
  it("exactPrMatch: one pull ref across all tagged files", () => {
    expect(exactPrMatch([{ metadata: pr }, { metadata: pr }])!.ref).toBe("o/uploads#1789");
  });
  it("exactPrMatch can use a fetched title while keeping its ref fallback", () => {
    const match = exactPrMatch([{ metadata: pr }])!;
    expect(
      applyGhTitles([match], {
        "o/uploads#1789": { title: "Use the resolved title", state: "open", kind: "pull" },
      })[0].label,
    ).toBe("Use the resolved title");
    expect(applyGhTitles([match], { "o/uploads#1789": null })[0].label).toBe("o/uploads#1789");
  });
  it("exactPrMatch: null on mixed refs or when the single ref is an issue", () => {
    expect(exactPrMatch([{ metadata: pr }, { metadata: issue }])).toBeNull();
    expect(exactPrMatch([{ metadata: issue }])).toBeNull();
    expect(exactPrMatch([{ metadata: undefined }])).toBeNull();
  });
  it("githubUrl maps kind → path", () => {
    expect(githubUrl("o/r", "pull", "5")).toBe("https://github.com/o/r/pull/5");
    expect(githubUrl("o/r", "issue", "5")).toBe("https://github.com/o/r/issues/5");
  });
});

function railItem(overrides: Partial<GhWorkItem> = {}): GhWorkItem {
  return {
    repo: "o/r",
    kind: "pull",
    number: "1",
    ref: "o/r#1",
    url: "https://github.com/o/r/pull/1",
    label: "o/r#1",
    kindLabel: "pull request",
    ...overrides,
  };
}

describe("applyGhTitles", () => {
  it("replaces labels for refs with fetched titles and leaves the rest", () => {
    const items = [railItem(), railItem({ ref: "o/r#2", number: "2", label: "stamped title" })];
    const out = applyGhTitles(items, {
      "o/r#1": { title: "Fresh title", state: "open", kind: "pull" },
      "o/r#2": null,
    });
    expect(out[0].label).toBe("Fresh title");
    expect(out[1].label).toBe("stamped title");
    expect(items[0].label).toBe("o/r#1"); // input untouched
  });

  it("ignores empty titles and unknown refs", () => {
    const items = [railItem()];
    expect(
      applyGhTitles(items, { "o/r#1": { title: "", state: "open", kind: "pull" } })[0].label,
    ).toBe("o/r#1");
    expect(applyGhTitles(items, {})[0].label).toBe("o/r#1");
  });
});
