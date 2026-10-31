/**
 * The Rust image crate (`apps/api/rust/image`), checked in as `image.wasm`.
 * It holds the classifier pHash (`phash-wasm.ts`) and the JPEG work for
 * video posters and PDF previews. Every caller falls back to the JS path
 * when the module is missing or a call fails.
 *
 * Only the API entry registers the module (`image-wasm-install.ts`), so the
 * MCP worker, which shares `files-core`, never bundles it. Rebuild with
 * `pnpm --filter @uploads/api image:wasm`.
 */

import { type WorkspaceRecord } from "./workspace";

/**
 * Flagship flag for the poster and PDF preview JPEG path. Same
 * `{ org, workspace }` context as the classifier flags.
 */
export const RUST_JPEG_FLAG = "rust-jpeg";

export interface ImageWasmExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  output_ptr(): number;
  phash(ptr: number, len: number, kind: number): bigint;
  poster_play(ptr: number, len: number): number;
  encode_jpeg(ptr: number, len: number, width: number, height: number, quality: number): number;
}

let loader: (() => Promise<WebAssembly.Module | undefined>) | null = null;
let loaded: Promise<WebAssembly.Module | undefined> | null = null;

export function registerImageWasm(load: () => Promise<WebAssembly.Module | undefined>): void {
  loader = load;
  loaded = null;
}

export function loadImageWasm(): Promise<WebAssembly.Module | undefined> {
  if (!loader) return Promise.resolve(undefined);
  loaded ??= loader().catch((err: unknown) => {
    console.error({ event: "image_wasm_load_failed", err });
    return undefined;
  });
  return loaded;
}

/**
 * A fresh instance per call, so decode memory is freed with the instance
 * instead of pinning the isolate. Returns the instance and the input's
 * pointer after copying `bytes` in.
 */
export function instantiateWith(
  module: WebAssembly.Module,
  bytes: Uint8Array,
): { exports: ImageWasmExports; ptr: number } {
  const exports = new WebAssembly.Instance(module, {}).exports as unknown as ImageWasmExports;
  const ptr = exports.alloc(bytes.length);
  new Uint8Array(exports.memory.buffer, ptr, bytes.length).set(bytes);
  return { exports, ptr };
}

function output(exports: ImageWasmExports, len: number): Uint8Array | undefined {
  if (len < 0) return undefined;
  return new Uint8Array(exports.memory.buffer, exports.output_ptr(), len).slice();
}

/** Poster JPEG with the play button baked in, or undefined on an unreadable frame. */
export function wasmPosterPlay(
  module: WebAssembly.Module,
  jpeg: Uint8Array,
): Uint8Array | undefined {
  const { exports, ptr } = instantiateWith(module, jpeg);
  return output(exports, exports.poster_play(ptr, jpeg.length));
}

/** 4:4:4 JPEG of an RGBA buffer, or undefined when the size does not match. */
export function wasmEncodeJpeg(
  module: WebAssembly.Module,
  rgba: Uint8Array,
  width: number,
  height: number,
  quality: number,
): Uint8Array | undefined {
  const { exports, ptr } = instantiateWith(module, rgba);
  return output(exports, exports.encode_jpeg(ptr, rgba.length, width, height, quality));
}

/**
 * The module when `rust-jpeg` is on for this workspace, else undefined.
 * A missing binding or a thrown evaluation is off.
 */
export async function rustJpegWasm(
  env: Env,
  ws: Pick<WorkspaceRecord, "name">,
  workspaceName: string,
): Promise<WebAssembly.Module | undefined> {
  if (!loader || !env.FLAGS) return undefined;
  // Same slug rule as `classifierEvaluationContext`.
  const slug = ws.name?.trim() || workspaceName;
  try {
    if (!(await env.FLAGS.getBooleanValue(RUST_JPEG_FLAG, false, { org: slug, workspace: slug }))) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return loadImageWasm();
}
