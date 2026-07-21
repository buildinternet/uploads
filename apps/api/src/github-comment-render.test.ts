import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { attachmentsCommentBody } from "./github-comment-render";

function loadFixture(name: string) {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new NodeURL(`../../../test/fixtures/${name}`, import.meta.url)),
      "utf8",
    ),
  ) as { items: any[]; galleries: any[]; marker?: string; expected: string };
}

const golden = loadFixture("github-comment-golden.json");
const goldenCap = loadFixture("github-comment-golden-cap.json");

describe("attachmentsCommentBody (api copy)", () => {
  it("renders the golden body byte-for-byte", () => {
    expect(attachmentsCommentBody(golden.items, golden.galleries)).toBe(golden.expected);
  });

  it("caps inline images at 16, collapsing the rest into a details block", () => {
    expect(attachmentsCommentBody(goldenCap.items, goldenCap.galleries, goldenCap.marker)).toBe(
      goldenCap.expected,
    );
  });
});
