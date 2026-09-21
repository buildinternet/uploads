/**
 * Bake a play-circle onto a poster JPEG so GitHub Camo (which will not play
 * an external MP4) still reads the still as a video.
 *
 * The glyph is one raster of Heroicons 24 solid `play-circle` (MIT) — circle
 * and rounded triangle designed together. We composite that PNG; we do not
 * draw the two shapes separately (that is what put the triangle off-center).
 */

import { decode, encode } from "jpeg-js";
import { PNG } from "pngjs";
import { playButtonPng } from "./poster-play-button";

/** Button diameter as a fraction of the shorter edge. */
export const PLAY_BUTTON_DIAMETER_RATIO = 0.22;
/** Re-encode quality after compositing. Matches the CLI still-image default. */
export const PLAY_BUTTON_JPEG_QUALITY = 85;
/** Below this shorter-edge, the glyph is unreadable — leave the frame alone. */
const MIN_EDGE_PX = 32;

/**
 * Overlay a play button on `jpeg`. Throws on an unreadable frame — callers
 * that want fail-open (keep the bare still) catch.
 */
export function overlayPlayButton(jpeg: Uint8Array): Uint8Array {
  const img = decode(jpeg, {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: 8,
    maxMemoryUsageInMB: 32,
  });
  if (Math.min(img.width, img.height) >= MIN_EDGE_PX) {
    const sprite = PNG.sync.read(Buffer.from(playButtonPng()));
    const size = Math.round(Math.min(img.width, img.height) * PLAY_BUTTON_DIAMETER_RATIO);
    compositeCentered(img.data, img.width, img.height, sprite, size);
  }
  const out = encode(
    { data: img.data, width: img.width, height: img.height },
    PLAY_BUTTON_JPEG_QUALITY,
  );
  return new Uint8Array(out.data);
}

interface PngSprite {
  width: number;
  height: number;
  data: Uint8Array;
}

function compositeCentered(
  dest: Uint8Array,
  dw: number,
  dh: number,
  sprite: PngSprite,
  size: number,
): void {
  if (size < 1) return;
  const x0 = Math.round((dw - size) / 2);
  const y0 = Math.round((dh - size) / 2);
  for (let y = 0; y < size; y++) {
    const dy = y0 + y;
    if (dy < 0 || dy >= dh) continue;
    const sy = ((y + 0.5) * sprite.height) / size - 0.5;
    for (let x = 0; x < size; x++) {
      const dx = x0 + x;
      if (dx < 0 || dx >= dw) continue;
      const sx = ((x + 0.5) * sprite.width) / size - 0.5;
      const [r, g, b, a] = sampleBilinear(sprite, sx, sy);
      if (a <= 0) continue;
      const i = (dy * dw + dx) * 4;
      const aa = a / 255;
      const inv = 1 - aa;
      dest[i] = dest[i] * inv + r * aa;
      dest[i + 1] = dest[i + 1] * inv + g * aa;
      dest[i + 2] = dest[i + 2] * inv + b * aa;
    }
  }
}

function sampleBilinear(
  sprite: PngSprite,
  sx: number,
  sy: number,
): [number, number, number, number] {
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const fx = sx - x0;
  const fy = sy - y0;
  const c00 = px(sprite, x0, y0);
  const c10 = px(sprite, x1, y0);
  const c01 = px(sprite, x0, y1);
  const c11 = px(sprite, x1, y1);
  return [
    lerp(lerp(c00[0], c10[0], fx), lerp(c01[0], c11[0], fx), fy),
    lerp(lerp(c00[1], c10[1], fx), lerp(c01[1], c11[1], fx), fy),
    lerp(lerp(c00[2], c10[2], fx), lerp(c01[2], c11[2], fx), fy),
    lerp(lerp(c00[3], c10[3], fx), lerp(c01[3], c11[3], fx), fy),
  ];
}

function px(sprite: PngSprite, x: number, y: number): [number, number, number, number] {
  const xx = x < 0 ? 0 : x >= sprite.width ? sprite.width - 1 : x;
  const yy = y < 0 ? 0 : y >= sprite.height ? sprite.height - 1 : y;
  const i = (yy * sprite.width + xx) * 4;
  return [sprite.data[i], sprite.data[i + 1], sprite.data[i + 2], sprite.data[i + 3]];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
