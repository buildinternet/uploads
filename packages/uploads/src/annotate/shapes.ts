/**
 * Per-annotation path generation: rough.js for sketchy shapes, perfect-freehand
 * for freeform strokes, opentype.js paths for label text.
 *
 * Not exported outside this module — only `index.ts` re-exports the public
 * surface (see the module header there).
 */
import { getStroke } from "perfect-freehand";
import rough from "roughjs/bundled/rough.esm.js";
import type { Drawable } from "roughjs/bundled/core.js";
import type { RoughGenerator } from "roughjs/bundled/generator.js";
import type {
  ArrowAnnotation,
  BoxAnnotation,
  DrawAnnotation,
  LabelAnnotation,
  Point,
  RedactAnnotation,
  SvgAnnotation,
} from "./spec.js";
import { measureText, textToPath } from "./text.js";

export const HOUSE_STYLE = {
  stroke: "#e11d48",
  roughness: 1.5,
  labelBorder: "#0f172a",
  labelFill: "#ffffff",
  labelFillOpacity: 0.92,
  redactFill: "#111111",
  redactBlurSigma: 18,
  labelPadding: 8,
} as const;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function pathsToSvg(gen: RoughGenerator, drawable: Drawable): string {
  return gen
    .toPaths(drawable)
    .map(
      (p) =>
        `<path d="${p.d}" fill="${p.fill ?? "none"}" stroke="${p.stroke ?? "none"}" stroke-width="${p.strokeWidth ?? 1}"/>`,
    )
    .join("");
}

interface RenderCtx {
  seed: number;
  scale: number;
}

function generator(ctx: RenderCtx): RoughGenerator {
  return rough.generator({ options: { seed: ctx.seed, roughness: HOUSE_STYLE.roughness } });
}

export function renderBox(a: BoxAnnotation, ctx: RenderCtx): string {
  const gen = generator(ctx);
  const strokeWidth = 3 * ctx.scale;
  const d = gen.rectangle(a.x, a.y, a.w, a.h, {
    stroke: a.color ?? HOUSE_STYLE.stroke,
    strokeWidth,
    fill: "none",
  });
  return pathsToSvg(gen, d);
}

/** Shared arrow rendering: rough shaft + two rough head strokes. */
function arrowSvg(from: Point, to: Point, color: string, ctx: RenderCtx): string {
  const gen = generator(ctx);
  const strokeWidth = 3 * ctx.scale;
  const [x1, y1] = from;
  const [x2, y2] = to;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLen = 22 * ctx.scale;
  const headSpread = 0.5;
  const hx1 = x2 - headLen * Math.cos(angle - headSpread);
  const hy1 = y2 - headLen * Math.sin(angle - headSpread);
  const hx2 = x2 - headLen * Math.cos(angle + headSpread);
  const hy2 = y2 - headLen * Math.sin(angle + headSpread);

  const shaft = gen.line(x1, y1, x2, y2, { stroke: color, strokeWidth });
  const headA = gen.line(x2, y2, hx1, hy1, { stroke: color, strokeWidth });
  const headB = gen.line(x2, y2, hx2, hy2, { stroke: color, strokeWidth });
  return pathsToSvg(gen, shaft) + pathsToSvg(gen, headA) + pathsToSvg(gen, headB);
}

export function renderArrow(a: ArrowAnnotation, ctx: RenderCtx): string {
  return arrowSvg(a.from, a.to, a.color ?? HOUSE_STYLE.stroke, ctx);
}

export function renderLabel(a: LabelAnnotation, ctx: RenderCtx): string {
  const color = a.color ?? HOUSE_STYLE.stroke;
  const fontSize = 28 * ctx.scale;
  const padding = HOUSE_STYLE.labelPadding * ctx.scale;
  // With no explicit `at`, offset the bubble above-right of its target so it
  // doesn't sit on top of the thing it labels (clamped to stay on-image).
  const at =
    a.at ??
    (a.target ? [a.target[0] + 30 * ctx.scale, Math.max(8, a.target[1] - 90 * ctx.scale)] : [0, 0]);
  const [atX, atY] = at;

  const metrics = measureText(a.text, fontSize);
  const bubbleW = metrics.width + padding * 2;
  const bubbleH = metrics.height + padding * 2;
  const bubbleX = atX;
  const bubbleY = atY;

  const gen = generator(ctx);
  const bubble = gen.rectangle(bubbleX, bubbleY, bubbleW, bubbleH, {
    stroke: HOUSE_STYLE.labelBorder,
    strokeWidth: 2 * ctx.scale,
    fill: HOUSE_STYLE.labelFill,
    fillStyle: "solid",
  });
  const bubbleSvg = `<g opacity="${HOUSE_STYLE.labelFillOpacity}">${pathsToSvg(gen, bubble)}</g>`;

  const textBaselineX = bubbleX + padding;
  const textBaselineY = bubbleY + padding + metrics.height * 0.78;
  const { d } = textToPath(a.text, textBaselineX, textBaselineY, fontSize);
  const textSvg = `<path d="${d}" fill="${HOUSE_STYLE.labelBorder}"/>`;

  let leaderSvg = "";
  if (a.target) {
    const [tx, ty] = a.target;
    const bubbleCenterX = bubbleX + bubbleW / 2;
    const bubbleCenterY = bubbleY + bubbleH / 2;
    // leader from the nearest bubble edge point toward the target
    const dx = tx - bubbleCenterX;
    const dy = ty - bubbleCenterY;
    const edgeX = dx === 0 ? bubbleCenterX : bubbleCenterX + Math.sign(dx) * (bubbleW / 2);
    const edgeY = dy === 0 ? bubbleCenterY : bubbleCenterY + Math.sign(dy) * (bubbleH / 2);
    leaderSvg = arrowSvg([edgeX, edgeY], [tx, ty], color, ctx);
  }

  return bubbleSvg + textSvg + leaderSvg;
}

/** Turns a perfect-freehand outline polygon into a closed SVG path `d`. */
function strokeToPath(stroke: number[][]): string {
  if (!stroke.length) return "";
  const d = stroke.reduce(
    (acc: (string | number)[], [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length]!;
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ["M", ...stroke[0]!, "Q"] as (string | number)[],
  );
  return `${d.join(" ")} Z`;
}

export function renderDraw(a: DrawAnnotation, ctx: RenderCtx): string {
  const color = a.color ?? HOUSE_STYLE.stroke;
  const stroke = getStroke(
    a.points.map(([x, y]) => [x, y]),
    { size: 4 * ctx.scale, smoothing: 0.6, streamline: 0.4 },
  );
  const d = strokeToPath(stroke);
  return `<path d="${d}" fill="${color}" opacity="0.9"/>`;
}

/** Redact overlay drawn into the SVG pass (solid style only; blur is a sharp pre-pass). */
export function renderRedactSolid(a: RedactAnnotation): string {
  return `<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="${HOUSE_STYLE.redactFill}"/>`;
}

export function renderSvg(a: SvgAnnotation): string {
  return `<g>${a.fragment}</g>`;
}

export function xmlEscape(text: string): string {
  return escapeXml(text);
}
