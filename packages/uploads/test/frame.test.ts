import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { applyFrame, listFramePresets, resolveFrameId } from "../src/frame.js";

async function solidPng(width: number, height: number): Promise<Uint8Array> {
  const buf = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 30, g: 120, b: 200 },
    },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

describe("resolveFrameId / listFramePresets", () => {
  it("lists built-in presets", () => {
    const ids = listFramePresets().map((p) => p.id);
    expect(ids).toEqual(["phone", "browser", "iphone-16-pro"]);
  });

  it("normalizes ids and rejects unknown", () => {
    expect(resolveFrameId("Phone")).toBe("phone");
    expect(() => resolveFrameId("toaster")).toThrow(/unknown frame/);
  });
});

describe("applyFrame (procedural)", () => {
  it("wraps a screenshot in a phone bezel and returns PNG", async () => {
    const shot = await solidPng(300, 600);
    const result = await applyFrame(shot, "ui.png", { id: "phone" });
    expect(result.framed).toBe(true);
    expect(result.frameId).toBe("phone");
    expect(result.filename).toBe("ui.png");
    expect(result.contentType).toBe("image/png");
    const meta = await sharp(result.bytes).metadata();
    expect(meta.format).toBe("png");
    // Bezel adds padding around the 390×844 design canvas (scaled from input).
    expect((meta.width ?? 0) * (meta.height ?? 0)).toBeGreaterThan(300 * 600);
  });

  it("wraps a screenshot in browser chrome", async () => {
    const shot = await solidPng(800, 500);
    const result = await applyFrame(shot, "dash.png", {
      id: "browser",
      browserUrl: "https://app.example/home",
    });
    expect(result.framed).toBe(true);
    expect(result.frameId).toBe("browser");
    const meta = await sharp(result.bytes).metadata();
    expect(meta.format).toBe("png");
    expect(meta.height ?? 0).toBeGreaterThan(500);
  });

  it("skips non-images", async () => {
    const bytes = new TextEncoder().encode("hello");
    const result = await applyFrame(bytes, "notes.txt", { id: "phone" });
    expect(result.framed).toBe(false);
    expect(result.skippedReason).toBe("not_image");
    expect(result.bytes).toBe(bytes);
  });
});
