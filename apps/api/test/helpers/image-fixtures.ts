/**
 * Minimal image headers with real, decodable dimensions — just enough bytes
 * for `detectContentType`/`detectImageDimensions` (guards.ts) to sniff, no
 * actual pixel data.
 */

/** PNG signature + IHDR chunk with the given dimensions. */
export function pngOf(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return bytes;
}

/** GIF89a header + logical screen descriptor with the given dimensions. */
export function gifOf(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // "GIF89a"
  new DataView(bytes.buffer).setUint16(6, width, true);
  new DataView(bytes.buffer).setUint16(8, height, true);
  return bytes;
}
