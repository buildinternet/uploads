/**
 * 63-bit DCT perceptual hash (Zauner 2010). 32×32 grayscale, then the 8×8
 * low-frequency coefficients excluding DC. Equality is the only match this
 * module is for: a wider Hamming gate is not safe here.
 */

import { decode } from "jpeg-js";
import { PNG } from "pngjs";
import { detectImageDimensions } from "./guards";

const SAMPLE = 32;
const LOW = 8;
/** Longest edge we will decode. Larger images skip the hash and call the model. */
const MAX_EDGE = 4096;
/** 4K-ish frames stay under this. RGBA for the cap is about 36 MB. */
const MAX_PIXELS = 9_000_000;

/**
 * Lowercase hex of the 63-bit hash, or `undefined` when the bytes are not a
 * PNG or JPEG we can decode inside the isolate.
 */
export function imagePhash(bytes: Uint8Array, contentType: string): string | undefined {
  if (contentType !== "image/png" && contentType !== "image/jpeg") return undefined;
  if (!phashInBounds(detectImageDimensions(bytes, contentType))) return undefined;
  try {
    const frame = contentType === "image/png" ? decodePng(bytes) : decodeJpeg(bytes);
    if (!frame) return undefined;
    return dctPhash(frame.data, frame.width, frame.height);
  } catch {
    return undefined;
  }
}

/** The size limits both the TS and Rust hashes apply before decoding. */
export function phashInBounds(dims: { width: number; height: number } | undefined): boolean {
  if (!dims || dims.width > MAX_EDGE || dims.height > MAX_EDGE) return false;
  return dims.width * dims.height <= MAX_PIXELS;
}

function decodePng(
  bytes: Uint8Array,
): { data: Uint8Array; width: number; height: number } | undefined {
  const Buf = (globalThis as unknown as { Buffer?: { from(data: Uint8Array): Uint8Array } }).Buffer;
  if (!Buf) return undefined;
  const png = PNG.sync.read(Buf.from(bytes));
  return { data: png.data, width: png.width, height: png.height };
}

function decodeJpeg(bytes: Uint8Array): { data: Uint8Array; width: number; height: number } {
  const img = decode(bytes, {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: 9,
    maxMemoryUsageInMB: 48,
  });
  return { data: img.data, width: img.width, height: img.height };
}

/** Box-average to 32×32, DCT-II, median of the 63 AC coefficients. */
function dctPhash(rgba: Uint8Array, width: number, height: number): string {
  const gray = new Float64Array(SAMPLE * SAMPLE);
  for (let y = 0; y < SAMPLE; y++) {
    const y0 = Math.floor((y * height) / SAMPLE);
    let y1 = Math.floor(((y + 1) * height) / SAMPLE);
    if (y1 <= y0) y1 = y0 + 1;
    for (let x = 0; x < SAMPLE; x++) {
      const x0 = Math.floor((x * width) / SAMPLE);
      let x1 = Math.floor(((x + 1) * width) / SAMPLE);
      if (x1 <= x0) x1 = x0 + 1;
      let sum = 0;
      let count = 0;
      for (let yy = y0; yy < y1 && yy < height; yy++) {
        const row = yy * width;
        for (let xx = x0; xx < x1 && xx < width; xx++) {
          const i = (row + xx) * 4;
          sum += rgba[i]! * 0.299 + rgba[i + 1]! * 0.587 + rgba[i + 2]! * 0.114;
          count++;
        }
      }
      gray[y * SAMPLE + x] = count === 0 ? 0 : sum / count;
    }
  }

  const rows = new Float64Array(SAMPLE * SAMPLE);
  const dct = new Float64Array(SAMPLE * SAMPLE);
  const scale = Math.PI / (2 * SAMPLE);
  for (let y = 0; y < SAMPLE; y++) {
    for (let u = 0; u < SAMPLE; u++) {
      let sum = 0;
      for (let x = 0; x < SAMPLE; x++) {
        sum += gray[y * SAMPLE + x]! * Math.cos((2 * x + 1) * u * scale);
      }
      rows[y * SAMPLE + u] = sum;
    }
  }
  for (let u = 0; u < SAMPLE; u++) {
    for (let v = 0; v < SAMPLE; v++) {
      let sum = 0;
      for (let y = 0; y < SAMPLE; y++) {
        sum += rows[y * SAMPLE + u]! * Math.cos((2 * y + 1) * v * scale);
      }
      dct[v * SAMPLE + u] = sum;
    }
  }

  const coeffs: number[] = [];
  for (let v = 0; v < LOW; v++) {
    for (let u = 0; u < LOW; u++) {
      if (u === 0 && v === 0) continue;
      coeffs.push(dct[v * SAMPLE + u]!);
    }
  }
  const median = [...coeffs].sort((a, b) => a - b)[31]!;
  let bits = 0n;
  for (let i = 0; i < coeffs.length; i++) {
    if (coeffs[i]! > median) bits |= 1n << BigInt(i);
  }
  return bits.toString(16).padStart(16, "0");
}
