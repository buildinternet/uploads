/**
 * Registration seam so the API worker can install the PDFium renderer
 * without the MCP worker bundling the WASM. `files-core` calls the hook;
 * only `pdf-preview.ts` (imported from the API entry) registers it.
 */

export interface PdfPreviewResult {
  jpeg: Uint8Array;
  /** Reserved `pdf.*` metadata to write on the source object. */
  meta: Record<string, string>;
}

export type PdfPreviewRenderer = (bytes: Uint8Array) => Promise<PdfPreviewResult | null>;

let renderer: PdfPreviewRenderer | null = null;

export function registerPdfPreviewRenderer(fn: PdfPreviewRenderer): void {
  renderer = fn;
}

export function getPdfPreviewRenderer(): PdfPreviewRenderer | null {
  return renderer;
}
