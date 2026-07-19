import { describe, it, expect } from "vitest";
import { ghWorkItemFromMetadata, connectedWork, exactPrMatch, githubUrl } from "./gh-context";

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
