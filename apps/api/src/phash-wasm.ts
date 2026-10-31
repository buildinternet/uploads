/**
 * Rust build of `phash.ts` (crate in `apps/api/rust/phash`), behind the
 * Flagship flag `phash-rust`. PNG hashes match the TS path bit for bit.
 * About 1 in 5 JPEGs differ by a few bits because the decoders round
 * differently, so a re-upload of an older JPEG can miss label reuse once.
 * The Rust decoder also hashes large JPEGs that jpeg-js rejects.
 *
 * Fails open: a missing flag, a thrown evaluation, or a wasm error uses
 * the TS hash. Rebuild `phash.wasm` with `pnpm phash:wasm`.
 */

import { detectImageDimensions } from "./guards";
import { imagePhash, phashInBounds } from "./phash";

export const PHASH_RUST_FLAG = "phash-rust";

const KIND: Record<string, number> = { "image/png": 1, "image/jpeg": 2 };

export type ImagePhash = (bytes: Uint8Array, contentType: string) => string | undefined;

/**
 * Hash with a fresh instance per call, so decode memory is freed with the
 * instance instead of pinning the isolate. Throws on a wasm fault.
 */
export function wasmImagePhash(
  module: WebAssembly.Module,
  bytes: Uint8Array,
  contentType: string,
): string | undefined {
  const kind = KIND[contentType];
  if (!kind || !phashInBounds(detectImageDimensions(bytes, contentType))) return undefined;
  const exports = new WebAssembly.Instance(module, {}).exports as {
    memory: WebAssembly.Memory;
    alloc(len: number): number;
    phash(ptr: number, len: number, kind: number): bigint;
  };
  const ptr = exports.alloc(bytes.length);
  new Uint8Array(exports.memory.buffer, ptr, bytes.length).set(bytes);
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
    const module = await loadPhashWasm();
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

/** Node tests cannot import `.wasm`; they load the file themselves. */
async function loadPhashWasm(): Promise<WebAssembly.Module | undefined> {
  if (import.meta.url?.startsWith("file:")) return undefined;
  return (await import("./phash-wasm-module")).default;
}
