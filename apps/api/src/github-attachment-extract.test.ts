import { describe, expect, it } from "vitest";
import {
  attachmentKeyBasename,
  extractUserAttachments,
  hasUserAttachmentUrl,
} from "./github-attachment-extract";

describe("extractUserAttachments", () => {
  it("finds bare, markdown-image, html img and video forms", () => {
    const text = [
      "intro https://github.com/user-attachments/assets/0a1b2c3d-1111-2222-3333-444455556666",
      "![shot](https://github.com/user-attachments/assets/9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff)",
      '<img src="https://github.com/user-attachments/assets/12345678-0000-0000-0000-000000000000" width="400">',
      '<video src="https://github.com/user-attachments/assets/87654321-0000-0000-0000-000000000000"></video>',
      "[log](https://github.com/user-attachments/files/1234/build-log.txt)",
    ].join("\n");
    const ids = extractUserAttachments(text).map((a) => a.id);
    expect(ids).toEqual([
      "assets/0a1b2c3d-1111-2222-3333-444455556666",
      "assets/9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff",
      "assets/12345678-0000-0000-0000-000000000000",
      "assets/87654321-0000-0000-0000-000000000000",
      "files/1234/build-log.txt",
    ]);
  });

  it("dedupes repeated references and ignores other github urls", () => {
    const u = "https://github.com/user-attachments/assets/0a1b2c3d-1111-2222-3333-444455556666";
    const text = `${u} and again ![x](${u}) plus https://github.com/acme/app/pull/7`;
    expect(extractUserAttachments(text)).toHaveLength(1);
    expect(extractUserAttachments("plain text")).toEqual([]);
  });

  it("strips trailing markdown/html delimiters from captured urls", () => {
    const text =
      "(see https://github.com/user-attachments/assets/0a1b2c3d-1111-2222-3333-444455556666)";
    expect(extractUserAttachments(text)[0]?.id).toBe("assets/0a1b2c3d-1111-2222-3333-444455556666");
  });
});

describe("hasUserAttachmentUrl", () => {
  it("is a cheap substring gate", () => {
    expect(hasUserAttachmentUrl("x https://github.com/user-attachments/assets/a1b2 y")).toBe(true);
    expect(hasUserAttachmentUrl("no attachments here")).toBe(false);
  });
});

describe("attachmentKeyBasename", () => {
  it("flattens ids into safe key basenames", () => {
    expect(attachmentKeyBasename("assets/0a1b-2c3d")).toBe("0a1b-2c3d");
    expect(attachmentKeyBasename("files/9/My Shot (final).png")).toBe("9-my-shot-final.png");
  });
});
