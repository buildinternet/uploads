/**
 * Minimal ambient types for opentype.js v2, which ships no declarations.
 * Deliberately NOT `@types/opentype.js`: that package types v1 and carries a
 * `/// <reference lib="dom" />` that leaks lib.dom into the whole program,
 * changing `fetch`'s BodyInit and breaking src/client.ts. Only the surface
 * used by ./text.ts is declared here.
 */
declare module "opentype.js" {
  export interface OpenTypePath {
    toPathData(decimals?: number): string;
  }
  export interface OpenTypeFont {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    getPath(text: string, x: number, y: number, fontSize: number): OpenTypePath;
    getAdvanceWidth(text: string, fontSize: number): number;
  }
  export function parse(buffer: ArrayBuffer): OpenTypeFont;
  const opentype: { parse: typeof parse };
  export default opentype;
}
