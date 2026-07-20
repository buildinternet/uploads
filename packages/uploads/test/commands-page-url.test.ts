import { describe, expect, it } from "vitest";
import type { ListItem } from "../src/client.js";
import { attachmentsCommentBody, type AttachmentItem } from "../src/github.js";

// Mirrors the gh-path projection in commands.ts: list items -> AttachmentItem.
function toAttachmentItems(items: ListItem[]): AttachmentItem[] {
  return items.map(({ key, url, embedUrl, pageUrl }) => ({ key, url, embedUrl, pageUrl }));
}

describe("gh-path attachment mapping", () => {
  it("carries pageUrl from the list item into the rendered href", () => {
    const items: ListItem[] = [
      {
        key: "gh/o/r/pull/1/a.png",
        url: "https://x.test/a.png",
        embedUrl: "https://embed.test/a.png",
        pageUrl: "https://uploads.sh/f/ws/gh/o/r/pull/1/a.png",
      },
    ];
    const body = attachmentsCommentBody(toAttachmentItems(items));
    expect(body).toContain('href="https://uploads.sh/f/ws/gh/o/r/pull/1/a.png"');
  });
});
