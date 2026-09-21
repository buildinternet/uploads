/**
 * First-page PDF raster (issue #1009).
 *
 * Engine: [clawpdf](https://github.com/openclaw/clawpdf) — PDFium WASM, no
 * native canvas. `render()` returns RGBA; jpeg-js encodes it. Browser Run is
 * not on this path. unpdf's `renderPageAsImage` needs a Node canvas and does
 * not run on workerd.
 *
 * Limits (also the skip rules — anything past them returns null):
 * - input: 20 MiB
 * - first page only, at most 2000 pages in the file
 * - page box at most 100 inches on a side
 * - raster width 640px, at most 1.2e6 pixels (about 640×1875)
 * - synchronous PDFium render; the upload path races a 10s wall clock
 *
 * The compiled WASM is about 5.0 MiB raw / 2.4 MiB gzip and is linked only
 * into the API worker (see pdf-preview-workerd.ts). Node tests and `wrangler`
 * dev take different startup paths because the Emscripten loader cannot
 * `createRequire` a bundled `import.meta.url`.
 */

import { createEngine, PdfError, type PdfEngine } from "clawpdf";
import { encode } from "jpeg-js";
import { overlayPdfBadge } from "./pdf-badge";
import { registerPdfPreviewRenderer, type PdfPreviewResult } from "./pdf-preview-hook";

/** Matches the video poster transform width. */
export const PDF_PREVIEW_WIDTH = 640;
/** RGBA budget handed to PDFium before it allocates the bitmap. */
export const PDF_PREVIEW_MAX_PIXELS = 1_200_000;
/** Skip files larger than this. Raster stays inside the isolate. */
export const PDF_PREVIEW_MAX_INPUT_BYTES = 20 * 1024 * 1024;
/** 100 inches in PDF points. Larger media boxes are treated as hostile. */
export const PDF_PREVIEW_MAX_PAGE_POINTS = 7_200;
/** Catalog page count above this is skipped. Page 1 would still be the only raster. */
export const PDF_PREVIEW_MAX_PAGES = 2_000;
/** Same quality the play-button overlay re-encodes at. */
const JPEG_QUALITY = 85;

let enginePromise: Promise<PdfEngine> | null = null;
let queue: Promise<void> = Promise.resolve();

/**
 * One PDFium heap per isolate, and one render at a time. Workers interleave
 * requests at `await`, and the WASM module is not re-entrant.
 */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function loadEngine(): Promise<PdfEngine> {
  // A bundled worker has no file URL. Node (vitest) does, and clawpdf's
  // default loader reads the WASM off disk there.
  if (import.meta.url.startsWith("file:")) {
    return createEngine({ maxRenderPixels: PDF_PREVIEW_MAX_PIXELS });
  }
  const { createBundledPdfEngine } = await import("./pdf-preview-workerd");
  return createBundledPdfEngine(PDF_PREVIEW_MAX_PIXELS);
}

function getEngine(): Promise<PdfEngine> {
  if (!enginePromise) {
    enginePromise = loadEngine().catch((err: unknown) => {
      enginePromise = null;
      throw err;
    });
  }
  return enginePromise;
}

function resetEngine(engine: PdfEngine | undefined): void {
  enginePromise = null;
  if (engine) void engine.destroy().catch(() => undefined);
}

/**
 * Rasterize page 1, or return null. Malformed, encrypted, and over-budget
 * documents are null — the comment then keeps the filename row.
 */
export async function renderPdfPreview(bytes: Uint8Array): Promise<PdfPreviewResult | null> {
  if (bytes.byteLength > PDF_PREVIEW_MAX_INPUT_BYTES) return null;
  if (bytes.byteLength < 5 || !isPdfHeader(bytes)) return null;
  return exclusive(() => renderExclusive(bytes));
}

async function renderExclusive(bytes: Uint8Array): Promise<PdfPreviewResult | null> {
  let engine: PdfEngine | undefined;
  try {
    engine = await getEngine();
    const doc = await engine.open(bytes);
    try {
      const pageCount = doc.pageCount;
      if (pageCount < 1 || pageCount > PDF_PREVIEW_MAX_PAGES) return null;
      const page = doc.page(1);
      if (
        page.width <= 0 ||
        page.height <= 0 ||
        page.width > PDF_PREVIEW_MAX_PAGE_POINTS ||
        page.height > PDF_PREVIEW_MAX_PAGE_POINTS
      ) {
        return null;
      }
      const rendered = page.render({
        width: PDF_PREVIEW_WIDTH,
        background: "white",
        forms: true,
      });
      if (rendered.width < 1 || rendered.height < 1) return null;
      // Copy out of the WASM heap before the document is destroyed.
      const rgba = overlayPdfBadge(rendered.rgba, rendered.width, rendered.height);
      const jpeg = encode(
        { data: rgba, width: rendered.width, height: rendered.height },
        JPEG_QUALITY,
      );
      const meta: Record<string, string> = {
        "pdf.poster": "1",
        "pdf.pages": String(pageCount),
        "pdf.width": String(rendered.width),
        "pdf.height": String(rendered.height),
      };
      return { jpeg: new Uint8Array(jpeg.data), meta };
    } finally {
      doc.destroy();
    }
  } catch (err) {
    if (!(err instanceof PdfError)) resetEngine(engine);
    return null;
  }
}

function isPdfHeader(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

/** Called from the API worker entry. MCP never calls this, so it never links PDFium. */
export function installPdfPreviewRenderer(): void {
  registerPdfPreviewRenderer(renderPdfPreview);
}
