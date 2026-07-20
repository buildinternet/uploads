import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { attachmentsCommentBody } from "../src/github.js";

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../test/fixtures/github-comment-golden.json", import.meta.url)),
    "utf8",
  ),
) as { items: any[]; galleries: any[]; expected: string };

describe("attachmentsCommentBody (CLI copy)", () => {
  it("renders the golden body byte-for-byte", () => {
    expect(attachmentsCommentBody(golden.items, golden.galleries)).toBe(golden.expected);
  });
});
