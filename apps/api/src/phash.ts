/**
 * 63-bit DCT perceptual hash (Zauner 2010). 32×32 grayscale, then the 8×8
 * low-frequency coefficients excluding DC. Equality is the only match this
 * module is for: a wider Hamming gate is not safe here.
 *
 * The hash runs in the Rust image crate (`image.wasm`, see `image-wasm.ts`).
 * PNG hashes match the earlier TS build bit for bit. About 1 in 5 JPEGs hash
 * a few bits apart from it, so a re-upload of a JPEG classified before
 * Nov 2026 can miss label reuse once.
 */

import { detectImageDimensions } from "./guards";
import { instantiateWith, loadImageWasm } from "./image-wasm";

/** Longest edge we will decode. Larger images skip the hash and call the model. */
const MAX_EDGE = 4096;
/** 4K-ish frames stay under this. RGBA for the cap is about 36 MB. */
const MAX_PIXELS = 9_000_000;

const KIND: Record<string, number> = { "image/png": 1, "image/jpeg": 2 };

/**
 * Lowercase hex of the 63-bit hash, or `undefined` when the bytes are not a
 * PNG or JPEG the module can decode inside the size limits.
 */
export type ImagePhash = (bytes: Uint8Array, contentType: string) => string | undefined;

export function phashInBounds(dims: { width: number; height: number } | undefined): boolean {
  if (!dims || dims.width > MAX_EDGE || dims.height > MAX_EDGE) return false;
  return dims.width * dims.height <= MAX_PIXELS;
}

/** Throws on a wasm fault. */
export function wasmImagePhash(
  module: WebAssembly.Module,
  bytes: Uint8Array,
  contentType: string,
): string | undefined {
  const kind = KIND[contentType];
  if (!kind || !phashInBounds(detectImageDimensions(bytes, contentType))) return undefined;
  const { exports, ptr } = instantiateWith(module, bytes);
  const hash = exports.phash(ptr, bytes.length, kind);
  return hash < 0n ? undefined : hash.toString(16).padStart(16, "0");
}

/**
 * The hasher for this isolate. Fails open: with no module (the MCP worker)
 * or on a wasm fault, images go unhashed and the classifier calls the model.
 */
export async function resolveImagePhash(): Promise<ImagePhash> {
  const module = await loadImageWasm();
  if (!module) return () => undefined;
  return (bytes, contentType) => {
    try {
      return wasmImagePhash(module, bytes, contentType);
    } catch (err) {
      console.error({ event: "phash_wasm_failed", err });
      return undefined;
    }
  };
}
