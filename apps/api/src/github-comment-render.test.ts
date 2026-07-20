import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { attachmentsCommentBody } from "./github-comment-render";

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(
      new NodeURL("../../../test/fixtures/github-comment-golden.json", import.meta.url),
    ),
    "utf8",
  ),
) as { items: any[]; galleries: any[]; expected: string };

describe("attachmentsCommentBody (api copy)", () => {
  it("renders the golden body byte-for-byte", () => {
    expect(attachmentsCommentBody(golden.items, golden.galleries)).toBe(golden.expected);
  });
});
