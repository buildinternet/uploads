/**
 * Corner badge so a PDF first page does not read as a screenshot in GitHub
 * Camo (same lesson as the video play button, issue #1008). Drawn in-process
 * — no sprite asset — because the mark is a short "PDF" label plus a page
 * outline.
 */

/** Badge shorter-edge floor. Below this the label is noise. */
const MIN_EDGE_PX = 64;
/** Gap between the badge and the image edge, in pixels. */
const MARGIN_PX = 10;

const GLYPHS: Record<string, string[]> = {
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
};

/**
 * Paint a small document badge onto the bottom-right of an RGBA buffer.
 * Returns a copy. Images too small to hold the badge are returned unchanged
 * (still a copy, so the caller can free the source).
 */
export function overlayPdfBadge(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const dest = new Uint8Array(rgba);
  if (Math.min(width, height) < MIN_EDGE_PX) return dest;
  const scale = Math.min(width, height) >= 480 ? 3 : 2;
  const badge = rasterBadge(scale);
  if (badge.width + MARGIN_PX * 2 > width || badge.height + MARGIN_PX * 2 > height) return dest;
  const x0 = width - MARGIN_PX - badge.width;
  const y0 = height - MARGIN_PX - badge.height;
  blit(dest, width, height, badge, x0, y0);
  return dest;
}

interface Raster {
  width: number;
  height: number;
  data: Uint8Array;
}

function rasterBadge(scale: number): Raster {
  const pad = 3;
  const iconW = 8;
  const iconH = 10;
  const gap = 3;
  const glyphW = 5;
  const glyphH = 7;
  const glyphGap = 1;
  const text = "PDF";
  const textW = text.length * glyphW + (text.length - 1) * glyphGap;
  const innerW = iconW + gap + textW;
  const innerH = Math.max(iconH, glyphH);
  const w = (pad * 2 + innerW) * scale;
  const h = (pad * 2 + innerH) * scale;
  const data = new Uint8Array(w * h * 4);
  fillRoundRect(data, w, h, scale, 23, 23, 23, 230);
  const iconX = (pad + 0) * scale;
  const iconY = (pad + Math.floor((innerH - iconH) / 2)) * scale;
  drawDocIcon(data, w, iconX, iconY, iconW * scale, iconH * scale);
  let gx = (pad + iconW + gap) * scale;
  const gy = (pad + Math.floor((innerH - glyphH) / 2)) * scale;
  for (const ch of text) {
    drawGlyph(data, w, GLYPHS[ch], gx, gy, scale);
    gx += (glyphW + glyphGap) * scale;
  }
  return { width: w, height: h, data };
}

function fillRoundRect(
  data: Uint8Array,
  width: number,
  height: number,
  radius: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  const rad = Math.max(1, radius);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (outsideRound(x, y, width, height, rad)) continue;
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
}

function outsideRound(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): boolean {
  const dx = x < radius ? radius - x : x >= width - radius ? x - (width - radius - 1) : 0;
  const dy = y < radius ? radius - y : y >= height - radius ? y - (height - radius - 1) : 0;
  return dx * dx + dy * dy > radius * radius;
}

/** Page outline with a folded corner, in white. */
function drawDocIcon(
  data: Uint8Array,
  stride: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): void {
  const fold = Math.max(2, Math.round(Math.min(w, h) * 0.35));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const edge =
        x === 0 ||
        y === 0 ||
        x === w - 1 ||
        y === h - 1 ||
        (x >= w - fold && y < fold && (x === w - fold || y === fold - 1));
      const inFold = x > w - fold && y < fold - 1;
      if (!edge || inFold) continue;
      setOpaque(data, stride, x0 + x, y0 + y, 255, 255, 255);
    }
  }
}

function drawGlyph(
  data: Uint8Array,
  stride: number,
  rows: string[],
  x0: number,
  y0: number,
  scale: number,
): void {
  for (let row = 0; row < rows.length; row++) {
    const bits = rows[row];
    for (let col = 0; col < bits.length; col++) {
      if (bits[col] !== "1") continue;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          setOpaque(data, stride, x0 + col * scale + sx, y0 + row * scale + sy, 255, 255, 255);
        }
      }
    }
  }
}

function setOpaque(
  data: Uint8Array,
  stride: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
): void {
  const i = (y * stride + x) * 4;
  data[i] = r;
  data[i + 1] = g;
  data[i + 2] = b;
  data[i + 3] = 255;
}

function blit(dest: Uint8Array, dw: number, dh: number, src: Raster, x0: number, y0: number): void {
  for (let y = 0; y < src.height; y++) {
    const dy = y0 + y;
    if (dy < 0 || dy >= dh) continue;
    for (let x = 0; x < src.width; x++) {
      const dx = x0 + x;
      if (dx < 0 || dx >= dw) continue;
      const si = (y * src.width + x) * 4;
      const a = src.data[si + 3];
      if (a === 0) continue;
      const di = (dy * dw + dx) * 4;
      const aa = a / 255;
      const inv = 1 - aa;
      dest[di] = dest[di] * inv + src.data[si] * aa;
      dest[di + 1] = dest[di + 1] * inv + src.data[si + 1] * aa;
      dest[di + 2] = dest[di + 2] * inv + src.data[si + 2] * aa;
    }
  }
}
