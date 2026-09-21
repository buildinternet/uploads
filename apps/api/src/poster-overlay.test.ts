import { decode, encode } from "jpeg-js";
import { describe, expect, it } from "vitest";
import { overlayPlayButton, PLAY_BUTTON_DIAMETER_RATIO } from "./poster-overlay";

function solidJpeg(width: number, height: number, r: number, g: number, b: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return new Uint8Array(encode({ data, width, height }, 95).data);
}

function px(data: Uint8Array, width: number, x: number, y: number): [number, number, number] {
  const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2]];
}

describe("overlayPlayButton", () => {
  it("paints a white circle and a dark triangle onto a dark frame", () => {
    const src = solidJpeg(320, 180, 16, 18, 22);
    const out = overlayPlayButton(src);
    const img = decode(out, { useTArray: true, formatAsRGBA: true });
    expect(img.width).toBe(320);
    expect(img.height).toBe(180);

    const cx = 160;
    const cy = 90;
    const radius = (Math.min(320, 180) * PLAY_BUTTON_DIAMETER_RATIO) / 2;

    // Lucide circle-play: base at cx-0.2R, tip at cx+0.4R. Left of the
    // base is disc fill; a point inside the triangle is dark.
    const [cr, cg, cb] = px(img.data, 320, Math.round(cx - radius * 0.45), cy);
    expect(cr).toBeGreaterThan(200);
    expect(cg).toBeGreaterThan(200);
    expect(cb).toBeGreaterThan(200);

    const [tr, tg, tb] = px(img.data, 320, Math.round(cx + radius * 0.15), cy);
    expect(tr).toBeLessThan(cr);
    expect(tg).toBeLessThan(cg);
    expect(tb).toBeLessThan(cb);
    expect(tr).toBeLessThan(90);

    // Lucide bbox center is (10+16)/2 = 13 in a 24 viewBox → cx + 0.1R.
    const luma = (x: number) => {
      const [r, g, b] = px(img.data, 320, x, cy);
      return (r + g + b) / 3;
    };
    const inner = Math.round(radius * 0.85);
    let x0: number | null = null;
    let x1: number | null = null;
    for (let x = cx - inner; x <= cx + inner; x++) {
      if (luma(x) < 90) {
        if (x0 === null) x0 = x;
        x1 = x;
      }
    }
    expect(x0).not.toBeNull();
    expect(x1).not.toBeNull();
    const mid = (x0! + x1!) / 2;
    const expected = cx + radius * 0.1;
    expect(Math.abs(mid - expected)).toBeLessThan(3);

    // Corner stays the original dark frame (lossy JPEG, not exact).
    const [fr, fg, fb] = px(img.data, 320, 2, 2);
    expect(fr).toBeLessThan(40);
    expect(fg).toBeLessThan(40);
    expect(fb).toBeLessThan(50);
  });

  it("strokes the disc so it still reads on a light frame", () => {
    const src = solidJpeg(320, 180, 245, 245, 248);
    const out = overlayPlayButton(src);
    const img = decode(out, { useTArray: true, formatAsRGBA: true });
    const cx = 160;
    const cy = 90;
    const radius = (Math.min(320, 180) * PLAY_BUTTON_DIAMETER_RATIO) / 2;
    const [rr, rg, rb] = px(img.data, 320, Math.round(cx - radius), cy);
    // Ring is a dark stroke — well below the light-gray frame.
    expect((rr + rg + rb) / 3).toBeLessThan(180);
  });

  it("is a no-op paint on a tiny frame (glyph would be unreadable)", () => {
    const src = solidJpeg(24, 16, 10, 10, 10);
    const out = overlayPlayButton(src);
    const img = decode(out, { useTArray: true, formatAsRGBA: true });
    const [r, g, b] = px(img.data, 24, 12, 8);
    expect(r).toBeLessThan(30);
    expect(g).toBeLessThan(30);
    expect(b).toBeLessThan(30);
  });

  it("throws on bytes that are not a jpeg", () => {
    expect(() => overlayPlayButton(new Uint8Array([1, 2, 3]))).toThrow();
  });
});
