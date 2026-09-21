import { describe, expect, it } from "vitest";
import { PASSWORD_PROTECTED_PDF, pdfWithNoPages, pdfWithText } from "../test/pdf-fixture";
import {
  PDF_PREVIEW_MAX_INPUT_BYTES,
  PDF_PREVIEW_MAX_PAGE_POINTS,
  renderPdfPreview,
} from "./pdf-preview";

describe("renderPdfPreview", () => {
  it("rasterizes page 1 to a JPEG and records page count", async () => {
    const made = await renderPdfPreview(pdfWithText("Hello PDF"));
    expect(made).not.toBeNull();
    expect(made!.jpeg[0]).toBe(0xff);
    expect(made!.jpeg[1]).toBe(0xd8);
    expect(made!.meta["pdf.poster"]).toBe("1");
    expect(made!.meta["pdf.pages"]).toBe("1");
    expect(Number(made!.meta["pdf.width"])).toBeGreaterThan(0);
    expect(Number(made!.meta["pdf.height"])).toBeGreaterThan(Number(made!.meta["pdf.width"]));
  });

  it("returns null for a truncated PDF", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    expect(await renderPdfPreview(bytes)).toBeNull();
  });

  it("returns null for a non-PDF header", async () => {
    expect(await renderPdfPreview(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull();
  });

  it("returns null above the input byte cap without rendering", async () => {
    const bytes = new Uint8Array(PDF_PREVIEW_MAX_INPUT_BYTES + 1);
    bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0);
    expect(await renderPdfPreview(bytes)).toBeNull();
  });

  it("returns null for a password-protected PDF", async () => {
    expect(await renderPdfPreview(PASSWORD_PROTECTED_PDF)).toBeNull();
  });

  it("returns null when the page tree is empty", async () => {
    expect(await renderPdfPreview(pdfWithNoPages())).toBeNull();
  });

  it("returns null when the page box is larger than the point cap", async () => {
    const huge = PDF_PREVIEW_MAX_PAGE_POINTS + 100;
    const bytes = pdfWithText("Huge", [0, 0, huge, huge]);
    expect(await renderPdfPreview(bytes)).toBeNull();
  });
});
