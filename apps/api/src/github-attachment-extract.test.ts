import { describe, expect, it } from "vitest";
import {
  attachmentKeyBasename,
  extractCursorContentAttachments,
  extractIngestAttachments,
  extractUnimportableCursorRefs,
  extractUserAttachments,
  hasCursorContentUrl,
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
    expect(attachmentKeyBasename("cursor/art-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).toBe(
      "art-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
  });
});

const CURSOR_ART = "art-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CURSOR_C = `https://cursor.com/artifacts/c/${CURSOR_ART}`;
const CURSOR_V = `https://cursor.com/artifacts/v/${CURSOR_ART}`;
const CURSOR_AGENT =
  "https://cursor.com/agents/bc-11111111-2222-4333-8444-555555555555/artifacts?path=/opt/cursor/artifacts/shot.webp";

describe("extractCursorContentAttachments", () => {
  it("finds bare, markdown-image, and html img forms and captures alt text", () => {
    const other = "art-bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const text = [
      `intro ${CURSOR_C}`,
      `![People invite links before](https://cursor.com/artifacts/c/${other})`,
      `<img alt="After settings" src="${CURSOR_C}" width="400">`,
    ].join("\n");
    expect(extractCursorContentAttachments(text)).toEqual([
      {
        id: `cursor/${CURSOR_ART}`,
        url: CURSOR_C,
        origin: "cursor",
        alt: "After settings",
      },
      {
        id: `cursor/${other}`,
        url: `https://cursor.com/artifacts/c/${other}`,
        origin: "cursor",
        alt: "People invite links before",
      },
    ]);
  });

  it("reads html alt when the attribute comes before src", () => {
    const text = `<img width="400" alt="Before shot" src="${CURSOR_C}">`;
    expect(extractCursorContentAttachments(text)[0]?.alt).toBe("Before shot");
  });

  it("dedupes and ignores viewer, agent-page, and unrelated cursor urls", () => {
    const text = [
      CURSOR_C,
      `![again](${CURSOR_C})`,
      CURSOR_V,
      CURSOR_AGENT,
      "https://cursor.com/docs/cloud-agent",
    ].join("\n");
    expect(extractCursorContentAttachments(text)).toEqual([
      { id: `cursor/${CURSOR_ART}`, url: CURSOR_C, origin: "cursor", alt: "again" },
    ]);
  });
});

describe("extractUnimportableCursorRefs", () => {
  it("collects viewer and agent-page urls for skip hints", () => {
    const text = `see ${CURSOR_V} and ${CURSOR_AGENT}`;
    expect(extractUnimportableCursorRefs(text)).toEqual([
      { url: CURSOR_V, kind: "viewer", artId: CURSOR_ART },
      { url: CURSOR_AGENT, kind: "agent_page" },
    ]);
  });
});

describe("extractIngestAttachments", () => {
  it("returns github and cursor /c/ urls together", () => {
    const gh = "https://github.com/user-attachments/assets/0a1b2c3d-1111-2222-3333-444455556666";
    const ids = extractIngestAttachments(`${gh} ${CURSOR_C}`).map((a) => a.id);
    expect(ids).toEqual(["assets/0a1b2c3d-1111-2222-3333-444455556666", `cursor/${CURSOR_ART}`]);
  });
});

describe("hasCursorContentUrl", () => {
  it("is a cheap substring gate for public rewrite urls", () => {
    expect(hasCursorContentUrl(`x ${CURSOR_C} y`)).toBe(true);
    expect(hasCursorContentUrl(CURSOR_V)).toBe(false);
    expect(hasCursorContentUrl(CURSOR_AGENT)).toBe(false);
  });
});
