/**
 * Rust build of `phash.ts` (in `image.wasm`, see `image-wasm.ts`), behind the
 * Flagship flag `phash-rust`. PNG hashes match the TS path bit for bit.
 * About 1 in 5 JPEGs differ by a few bits because the decoders round
 * differently, so a re-upload of an older JPEG can miss label reuse once.
 * The Rust decoder also hashes large JPEGs that jpeg-js rejects.
 *
 * Fails open: a missing flag, a thrown evaluation, or a wasm error uses
 * the TS hash.
 */

import { detectImageDimensions } from "./guards";
import { instantiateWith, loadImageWasm } from "./image-wasm";
import { imagePhash, phashInBounds } from "./phash";

export const PHASH_RUST_FLAG = "phash-rust";

const KIND: Record<string, number> = { "image/png": 1, "image/jpeg": 2 };

export type ImagePhash = (bytes: Uint8Array, contentType: string) => string | undefined;

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
 * The hasher for this workspace: Rust when the flag is on, TS otherwise.
 * `context` is the classifier's `{ org, workspace }` evaluation context.
 */
export async function resolveImagePhash(
  env: Env,
  context: { org: string; workspace: string },
): Promise<ImagePhash> {
  if (!env.FLAGS) return imagePhash;
  try {
    if (!(await env.FLAGS.getBooleanValue(PHASH_RUST_FLAG, false, context))) return imagePhash;
    const module = await loadImageWasm();
    if (!module) return imagePhash;
    return (bytes, contentType) => {
      try {
        return wasmImagePhash(module, bytes, contentType);
      } catch (err) {
        console.error({ event: "phash_wasm_failed", err });
        return imagePhash(bytes, contentType);
      }
    };
  } catch {
    return imagePhash;
  }
}
