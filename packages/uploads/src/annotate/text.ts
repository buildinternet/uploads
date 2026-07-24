/**
 * Text-as-paths via opentype.js + the bundled Excalifont.
 *
 * Not exported outside this module — only `index.ts` re-exports the public
 * surface (see the module header there). Rendering label text as SVG paths
 * (instead of an SVG `<text>` element) sidesteps librsvg's fontconfig-based
 * font resolution entirely, so the renderer produces identical output no
 * matter which fonts happen to be installed on the host.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";

const FONT_URL = new URL("../../assets/Excalifont-Regular.ttf", import.meta.url);

let cachedFont: opentype.Font | undefined;

function loadFont(): opentype.Font {
  if (!cachedFont) {
    const buf = readFileSync(fileURLToPath(FONT_URL));
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    cachedFont = opentype.parse(arrayBuffer as ArrayBuffer);
  }
  return cachedFont;
}

export interface TextMetrics {
  /** SVG path `d` data, already positioned at the requested x/y baseline. */
  d: string;
  /** Total advance width in pixels at the requested font size. */
  width: number;
  /** Ascent + descent in pixels at the requested font size (line height). */
  height: number;
}

/** Renders `text` to an SVG path at the given baseline origin and font size (px). */
export function textToPath(text: string, x: number, y: number, fontSize: number): TextMetrics {
  const font = loadFont();
  const path = font.getPath(text, x, y, fontSize);
  const width = font.getAdvanceWidth(text, fontSize);
  const scale = fontSize / font.unitsPerEm;
  const height = (font.ascender - font.descender) * scale;
  return { d: path.toPathData(2), width, height };
}

/** Measures `text` at the given font size without generating path data. */
export function measureText(text: string, fontSize: number): { width: number; height: number } {
  const font = loadFont();
  const width = font.getAdvanceWidth(text, fontSize);
  const scale = fontSize / font.unitsPerEm;
  const height = (font.ascender - font.descender) * scale;
  return { width, height };
}
