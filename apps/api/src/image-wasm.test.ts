import { readFileSync } from "node:fs";
import { decode, encode } from "jpeg-js";
import { describe, expect, it } from "vitest";
import { wasmEncodeJpeg, wasmPosterPlay } from "./image-wasm";
import { overlayPlayButton } from "./poster-overlay";
import { playButtonPng } from "./poster-play-button";

/** Workers types only declare the bundled-module form, so build it the Node way. */
const NodeModule = WebAssembly.Module as unknown as new (bytes: Uint8Array) => WebAssembly.Module;
const wasm = new NodeModule(readFileSync(new URL("./image.wasm", import.meta.url).pathname));

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

function rgbaOf(jpeg: Uint8Array) {
  return decode(jpeg, { useTArray: true, formatAsRGBA: true });
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

describe("image.wasm", () => {
  it("embeds the same play-button PNG as poster-play-button.ts", () => {
    const asset = readFileSync(
      new URL("../rust/image/assets/play-button.png", import.meta.url).pathname,
    );
    expect(Buffer.from(playButtonPng()).equals(asset)).toBe(true);
  });

  it("bakes the play button like the JS overlay", () => {
    const src = new Uint8Array(
      encode({ data: gradient(640, 360), width: 640, height: 360 }, 90).data,
    );
    const rust = wasmPosterPlay(wasm, src);
    expect(rust).toBeDefined();
    const a = rgbaOf(rust!);
    const b = rgbaOf(overlayPlayButton(src));
    expect([a.width, a.height]).toEqual([640, 360]);
    expect(meanDiff(a.data, b.data)).toBeLessThan(2);
  });

  it("returns undefined for an unreadable frame", () => {
    expect(wasmPosterPlay(wasm, new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it("encodes RGBA close to jpeg-js at the same quality", () => {
    const rgba = gradient(640, 480);
    const rust = wasmEncodeJpeg(wasm, rgba, 640, 480, 85);
    expect(rust).toBeDefined();
    const js = new Uint8Array(encode({ data: rgba, width: 640, height: 480 }, 85).data);
    expect(meanDiff(rgbaOf(rust!).data, rgbaOf(js).data)).toBeLessThan(2);
  });

  it("rejects a buffer that does not match its size", () => {
    expect(wasmEncodeJpeg(wasm, new Uint8Array(10), 640, 480, 85)).toBeUndefined();
  });
});
