/**
 * `renderAnnotations` — the sole render entry point of the annotate module.
 * Pure: image + resolved spec in, PNG out. No browser/playwright knowledge.
 *
 * Not exported outside this module directly — only `index.ts` re-exports it
 * (see the module header there). Callers that import `index.ts` and reach
 * `renderAnnotations` must dynamic-`import()` it, because this file imports
 * `sharp` statically and sharp must stay out of the static import graphs of
 * `src/index.ts`, `src/agent.ts`, and `src/mcp/server.ts`.
 */
import sharp from "sharp";
import {
  renderArrow,
  renderBox,
  renderDraw,
  renderLabel,
  renderRedactSolid,
  renderSvg,
  HOUSE_STYLE,
} from "./shapes.js";
import { AnnotateSpecError, hasSelectors, type Annotation, type AnnotationSpec } from "./spec.js";

const DEFAULT_SEED = 7;
const BASE_SCALE_REFERENCE_WIDTH = 1280;

export interface RenderOptions {
  seed?: number;
  scale?: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function clampBox(box: Box, width: number, height: number): { box: Box; clamped: boolean } {
  const x = Math.max(0, Math.min(box.x, width));
  const y = Math.max(0, Math.min(box.y, height));
  const w = Math.max(0, Math.min(box.w, width - x));
  const h = Math.max(0, Math.min(box.h, height - y));
  const clamped = x !== box.x || y !== box.y || w !== box.w || h !== box.h;
  return { box: { x, y, w, h }, clamped };
}

/** Clamps a single geometric annotation's fields in place to a new plain object. */
function clampAnnotation(
  a: Annotation,
  width: number,
  height: number,
): { annotation: Annotation; clamped: boolean } {
  switch (a.type) {
    case "box":
    case "redact": {
      const { box, clamped } = clampBox({ x: a.x, y: a.y, w: a.w, h: a.h }, width, height);
      return { annotation: { ...a, ...box }, clamped };
    }
    case "arrow": {
      const clampPoint = (p: [number, number]): [[number, number], boolean] => {
        const cx = Math.max(0, Math.min(p[0], width));
        const cy = Math.max(0, Math.min(p[1], height));
        return [[cx, cy], cx !== p[0] || cy !== p[1]];
      };
      const [from, fromClamped] = clampPoint(a.from);
      const [to, toClamped] = clampPoint(a.to);
      return { annotation: { ...a, from, to }, clamped: fromClamped || toClamped };
    }
    case "label": {
      const at = a.at ?? a.target;
      if (!at) return { annotation: a, clamped: false };
      const cx = Math.max(0, Math.min(at[0], width));
      const cy = Math.max(0, Math.min(at[1], height));
      const clamped = cx !== at[0] || cy !== at[1];
      if (!clamped) return { annotation: a, clamped: false };
      return { annotation: a.at ? { ...a, at: [cx, cy] } : a, clamped };
    }
    case "draw":
    case "svg":
    default:
      return { annotation: a, clamped: false };
  }
}

/**
 * Reports which annotations (by index) fall outside `[0, width) x [0, height)`
 * and would be clamped by `renderAnnotations`. Pure and side-effect-free —
 * the CLI layer decides how to surface these as warnings.
 */
export function clampReport(spec: AnnotationSpec, width: number, height: number): string[] {
  const warnings: string[] = [];
  spec.annotations.forEach((a, index) => {
    const { clamped } = clampAnnotation(a, width, height);
    if (clamped) {
      warnings.push(`annotations[${index}]: geometry out of bounds, clamped to image size`);
    }
  });
  return warnings;
}

function scaleFor(width: number, opts?: RenderOptions): number {
  if (opts?.scale) return opts.scale;
  return Math.max(1, Math.round(width / BASE_SCALE_REFERENCE_WIDTH));
}

async function redactBlurLayer(
  base: Buffer,
  region: Box,
  width: number,
  height: number,
): Promise<{ input: Buffer; left: number; top: number } | null> {
  const left = Math.round(region.x);
  const top = Math.round(region.y);
  const w = Math.round(region.w);
  const h = Math.round(region.h);
  if (w <= 0 || h <= 0 || left >= width || top >= height) return null;
  const clampedW = Math.min(w, width - left);
  const clampedH = Math.min(h, height - top);
  if (clampedW <= 0 || clampedH <= 0) return null;
  const blurred = await sharp(base)
    .extract({ left, top, width: clampedW, height: clampedH })
    .blur(HOUSE_STYLE.redactBlurSigma)
    .png()
    .toBuffer();
  return { input: blurred, left, top };
}

/**
 * Renders `spec` onto `image`, returning a new PNG buffer. Deterministic for
 * a fixed `opts.seed` (defaults to 7). Throws `AnnotateSpecError` if any
 * annotation still carries an unresolved `selector` — selectors must be
 * resolved to pixel geometry (via `resolveSelectors`) before rendering.
 */
export async function renderAnnotations(
  image: Buffer | Uint8Array,
  spec: AnnotationSpec,
  opts?: RenderOptions,
): Promise<Buffer> {
  if (hasSelectors(spec)) {
    throw new AnnotateSpecError([
      { index: null, message: "spec still has unresolved selectors; call resolveSelectors first" },
    ]);
  }

  const base = Buffer.isBuffer(image) ? image : Buffer.from(image);
  const baseImg = sharp(base);
  const meta = await baseImg.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const seed = opts?.seed ?? DEFAULT_SEED;
  const scale = scaleFor(width, opts);
  const ctx = { seed, scale };

  const clamped = spec.annotations.map((a) => clampAnnotation(a, width, height).annotation);

  // Blur redactions are applied as a pre-pass (extract -> blur -> composite
  // back) BEFORE the sketchy overlay pass, per the house style. The blurs are
  // independent reads of the same immutable base, so they run concurrently.
  const compositeOps = (
    await Promise.all(
      clamped.map((annotation) =>
        annotation.type === "redact" && (annotation.style ?? "solid") === "blur"
          ? redactBlurLayer(
              base,
              { x: annotation.x, y: annotation.y, w: annotation.w, h: annotation.h },
              width,
              height,
            )
          : Promise.resolve(null),
      ),
    )
  ).filter((layer): layer is { input: Buffer; left: number; top: number } => layer !== null);

  const overlayParts: string[] = [];
  for (const annotation of clamped) {
    switch (annotation.type) {
      case "box":
        overlayParts.push(renderBox(annotation, ctx));
        break;
      case "arrow":
        overlayParts.push(renderArrow(annotation, ctx));
        break;
      case "label":
        overlayParts.push(renderLabel(annotation, ctx));
        break;
      case "draw":
        overlayParts.push(renderDraw(annotation, ctx));
        break;
      case "redact":
        if ((annotation.style ?? "solid") === "solid") {
          overlayParts.push(renderRedactSolid(annotation));
        }
        break;
      case "svg":
        overlayParts.push(renderSvg(annotation));
        break;
    }
  }

  const overlaySvg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${overlayParts.join(
    "",
  )}</svg>`;
  compositeOps.push({ input: Buffer.from(overlaySvg), left: 0, top: 0 });

  return sharp(base).composite(compositeOps).png().toBuffer();
}
