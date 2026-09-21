/**
 * Bake a centered play-button onto a poster JPEG so GitHub Camo (which
 * will not play an external MP4) still reads the still as a video.
 *
 * Media Transformations has no overlay/draw, and this worker has no Images
 * binding, so the composite is a decode → paint → re-encode in-process.
 * jpeg-js is pure JS (nodejs_compat Buffer is enough); a 640px frame is
 * well under a millisecond on the isolate.
 */

import { decode, encode } from "jpeg-js";

/** Circle diameter as a fraction of the shorter edge. */
export const PLAY_BUTTON_DIAMETER_RATIO = 0.22;
/** Re-encode quality after painting. Matches the CLI still-image default. */
export const PLAY_BUTTON_JPEG_QUALITY = 85;
/** Below this shorter-edge, the glyph is unreadable — leave the frame alone. */
const MIN_EDGE_PX = 32;

const CIRCLE = { r: 255, g: 255, b: 255, a: 0.92 };
const SHADOW = { r: 0, g: 0, b: 0, a: 0.22 };
const RING = { r: 40, g: 42, b: 48, a: 0.32 };
const TRIANGLE = { r: 45, g: 47, b: 54, a: 0.96 };
const AA_PX = 0.85;
const RING_WIDTH_PX = 2.2;

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
    drawPlayButton(img.data, img.width, img.height);
  }
  const out = encode(
    { data: img.data, width: img.width, height: img.height },
    PLAY_BUTTON_JPEG_QUALITY,
  );
  return new Uint8Array(out.data);
}

/** Paint the glyph into an RGBA buffer (source-over; alpha stays 255). */
export function drawPlayButton(data: Uint8Array, width: number, height: number): void {
  const cx = width / 2;
  const cy = height / 2;
  const radius = (Math.min(width, height) * PLAY_BUTTON_DIAMETER_RATIO) / 2;
  const shadowPad = 3;
  const x0 = Math.max(0, Math.floor(cx - radius - shadowPad - 1));
  const y0 = Math.max(0, Math.floor(cy - radius - shadowPad - 1));
  const x1 = Math.min(width, Math.ceil(cx + radius + shadowPad + 1));
  const y1 = Math.min(height, Math.ceil(cy + radius + shadowPad + 1));

  // Right-pointing triangle, bbox-centered on the disc, then nudged a
  // hair east so the tip does not make the glyph look left-heavy.
  const triH = radius * 1.02;
  const triW = radius * 0.88;
  const opticalX = radius * 0.06;
  const left = cx - triW / 2 + opticalX;
  const right = cx + triW / 2 + opticalX;
  const top = cy - triH / 2;
  const bot = cy + triH / 2;
  // CCW: tip → base-bottom → base-top.
  const v0x = right;
  const v0y = cy;
  const v1x = left;
  const v1y = bot;
  const v2x = left;
  const v2y = top;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const dx = px - cx;
      const dy = py - cy;
      const dist = Math.hypot(dx, dy);
      const i = (y * width + x) * 4;

      const shadowCov = coverage(radius + shadowPad - dist);
      blend(data, i, SHADOW.r, SHADOW.g, SHADOW.b, SHADOW.a * shadowCov);

      const circleCov = coverage(radius - dist);
      blend(data, i, CIRCLE.r, CIRCLE.g, CIRCLE.b, CIRCLE.a * circleCov);

      // Stroke so the disc still reads on a light frame, where the white
      // fill otherwise disappears into the screenshot.
      const ringCov = coverage(RING_WIDTH_PX / 2 - Math.abs(dist - radius));
      blend(data, i, RING.r, RING.g, RING.b, RING.a * ringCov);

      const triCov = coverage(signedDistTriangle(px, py, v0x, v0y, v1x, v1y, v2x, v2y));
      blend(data, i, TRIANGLE.r, TRIANGLE.g, TRIANGLE.b, TRIANGLE.a * triCov);
    }
  }
}

/** 1 inside, 0 outside, linear 1px-ish falloff across the edge. */
function coverage(signedInside: number): number {
  const t = signedInside / AA_PX + 0.5;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
}

function blend(data: Uint8Array, i: number, r: number, g: number, b: number, a: number): void {
  if (a <= 0) return;
  const aa = a > 1 ? 1 : a;
  const inv = 1 - aa;
  data[i] = data[i] * inv + r * aa;
  data[i + 1] = data[i + 1] * inv + g * aa;
  data[i + 2] = data[i + 2] * inv + b * aa;
}

/**
 * Signed distance to a CCW triangle: positive inside. Edge distances only —
 * good enough for a 1px AA fringe on a convex glyph.
 */
function signedDistTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  return Math.min(
    edgeDist(px, py, ax, ay, bx, by),
    edgeDist(px, py, bx, by, cx, cy),
    edgeDist(px, py, cx, cy, ax, ay),
  );
}

function edgeDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const len = Math.hypot(abx, aby);
  if (len === 0) return 0;
  return (abx * (py - ay) - aby * (px - ax)) / len;
}
