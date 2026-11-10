import { crc32, deflateSync } from "node:zlib";
import { encode } from "jpeg-js";
import { describe, expect, it } from "vitest";
import { loadImageWasm } from "./image-wasm";
import { resolveImagePhash, wasmImagePhash } from "./phash";

const wasm = (await loadImageWasm())!;

function rgba(width: number, height: number, seed: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 7 + seed) & 255;
      data[i + 1] = (y * 5 + x * seed) & 255;
      data[i + 2] = ((x ^ y) * 3) & 255;
      data[i + 3] = 255;
    }
  }
  return data;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** RGBA, 8-bit, filter 0 on every row. */
function png(width: number, height: number, seed: number): Uint8Array {
  const pixels = rgba(width, height, seed);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}

const GOLDEN = ["5813f942d2dbf902", "22aba3bd7c2fac00", "314edaa70d335c58"];

describe("wasmImagePhash", () => {
  // Hashes the removed TS (pngjs) path wrote for these images. Stored PNG
  // hashes must keep matching, or label reuse misses on old uploads.
  it("keeps the TS hashes on PNG", () => {
    const hashes = [
      [400, 300, 1],
      [333, 517, 9],
      [64, 40, 3],
    ].map(([w, h, seed]) => wasmImagePhash(wasm, png(w!, h!, seed!), "image/png"));
    expect(hashes).toEqual(GOLDEN);
  });

  it("hashes JPEG", () => {
    const { data } = encode({ data: rgba(320, 240, 5), width: 320, height: 240 }, 85);
    expect(wasmImagePhash(wasm, new Uint8Array(data), "image/jpeg")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns undefined for other types and unreadable bytes", () => {
    expect(wasmImagePhash(wasm, png(40, 40, 1), "image/webp")).toBeUndefined();
    const truncated = png(200, 200, 2).slice(0, 60);
    expect(wasmImagePhash(wasm, truncated, "image/png")).toBeUndefined();
  });
});

describe("resolveImagePhash", () => {
  it("hashes with the registered module", async () => {
    const hash = await resolveImagePhash();
    expect(hash(png(400, 300, 1), "image/png")).toBe(GOLDEN[0]);
  });
});
