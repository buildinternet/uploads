/**
 * Minimal non-image payload headers — just enough leading bytes for
 * `detectContentType` (guards.ts) to sniff, no real file structure.
 */

/** %PDF-1.7 header. */
export const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);

/** PK\x03\x04 local file header. */
export const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

/** PK\x05\x06 end-of-central-directory (an archive with no entries). */
export const ZIP_EMPTY = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]);

/** gzip member header. */
export const GZIP = new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0]);

/** ISO base media `ftyp` box (offset 4) with the given major brand, then any compatible brands. */
export function ftyp(brand: string, ...compatible: string[]): Uint8Array {
  const brands = [brand, "\0\0\0\0", ...compatible].join("");
  const bytes = new Uint8Array(8 + brands.length);
  bytes.set([0, 0, 0, bytes.length, 0x66, 0x74, 0x79, 0x70]); // size + "ftyp"
  for (let i = 0; i < brands.length; i++) bytes[8 + i] = brands.charCodeAt(i);
  return bytes;
}

/** QuickTime: an ftyp box with the "qt  " major brand. */
export const MOV = ftyp("qt  ");

/** AVIF: an ftyp box with the "avif" major brand. */
export const AVIF = ftyp("avif");
