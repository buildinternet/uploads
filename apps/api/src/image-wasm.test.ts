import { decode, encode } from "jpeg-js";
import { describe, expect, it } from "vitest";
import { loadImageWasm, wasmEncodeJpeg, wasmPosterPlay } from "./image-wasm";

const wasm = (await loadImageWasm())!;

function solid(width: number, height: number, r: number, g: number, b: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return data;
}

function gradient(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 255) / width;
      data[i + 1] = (y * 255) / height;
      data[i + 2] = 90;
      data[i + 3] = 255;
    }
  }
  return data;
}

function jpegOf(data: Uint8Array, width: number, height: number): Uint8Array {
  return new Uint8Array(encode({ data, width, height }, 95).data);
}

function rgbaOf(jpeg: Uint8Array) {
  return decode(jpeg, { useTArray: true, formatAsRGBA: true });
}

function px(data: Uint8Array, width: number, x: number, y: number): [number, number, number] {
  const i = (y * width + x) * 4;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
}

/** Mean absolute difference per channel, ignoring alpha. */
function meanDiff(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) sum += Math.abs(a[i + c]! - b[i + c]!);
    n += 3;
  }
  return sum / n;
}

describe("wasmPosterPlay", () => {
  it("composites the play-circle onto a dark frame", () => {
    const out = wasmPosterPlay(wasm, jpegOf(solid(320, 180, 16, 18, 22), 320, 180));
    const img = rgbaOf(out!);
    expect([img.width, img.height]).toEqual([320, 180]);

    // Disc fill left of the triangle, still inside the circle.
    for (const c of px(img.data, 320, 160 - 12, 90)) expect(c).toBeGreaterThan(180);
    // The triangle sits slightly east of center, so just right of center is dark.
    const [tr, tg, tb] = px(img.data, 320, 164, 90);
    expect((tr + tg + tb) / 3).toBeLessThan(120);
    // Corners keep the frame.
    for (const c of px(img.data, 320, 2, 2)) expect(c).toBeLessThan(50);
  });

  it("leaves a tiny frame unpainted", () => {
    const img = rgbaOf(wasmPosterPlay(wasm, jpegOf(solid(24, 16, 10, 10, 10), 24, 16))!);
    for (const c of px(img.data, 24, 12, 8)) expect(c).toBeLessThan(30);
  });

  it("returns undefined for an unreadable frame", () => {
    expect(wasmPosterPlay(wasm, new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});

describe("wasmEncodeJpeg", () => {
  it("round-trips RGBA at the given size", () => {
    const rgba = gradient(640, 480);
    const img = rgbaOf(wasmEncodeJpeg(wasm, rgba, 640, 480, 85)!);
    expect([img.width, img.height]).toEqual([640, 480]);
    expect(meanDiff(img.data, rgba)).toBeLessThan(2);
  });

  it("rejects a buffer that does not match its size", () => {
    expect(wasmEncodeJpeg(wasm, new Uint8Array(10), 640, 480, 85)).toBeUndefined();
  });
});
