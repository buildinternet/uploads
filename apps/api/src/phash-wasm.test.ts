import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { encode } from "jpeg-js";
import { describe, expect, it } from "vitest";
import { imagePhash } from "./phash";
import { wasmImagePhash } from "./phash-wasm";

/** Workers types only declare the bundled-module form, so build it the Node way. */
const NodeModule = WebAssembly.Module as unknown as new (bytes: Uint8Array) => WebAssembly.Module;
const wasm = new NodeModule(readFileSync(new URL("./phash.wasm", import.meta.url).pathname));

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

describe("wasmImagePhash", () => {
  it("matches the TS hash on PNG", () => {
    for (const [w, h, seed] of [
      [400, 300, 1],
      [333, 517, 9],
      [64, 40, 3],
    ] as const) {
      const bytes = png(w, h, seed);
      const ts = imagePhash(bytes, "image/png");
      expect(ts).toMatch(/^[0-9a-f]{16}$/);
      expect(wasmImagePhash(wasm, bytes, "image/png")).toBe(ts);
    }
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
