/**
 * Screenshot annotation module — hand-drawn boxes, arrows, labels, freeform
 * strokes, and redactions baked onto an image before upload.
 *
 * This file is the ONLY public surface of `src/annotate/`. Nothing outside
 * this module may import from `./spec.js`, `./render.js`, `./shapes.js`, or
 * `./text.js` directly — always go through here, so the renderer stays
 * swappable (tldraw, a server-side `/v1/render`, …) without touching CLI
 * callers.
 */
export type {
  Annotation,
  AnnotationSpec,
  ArrowAnnotation,
  BoxAnnotation,
  DrawAnnotation,
  LabelAnnotation,
  Point,
  RedactAnnotation,
  SpecError,
  SvgAnnotation,
} from "./spec.js";
export {
  AnnotateSpecError,
  hasSelectors,
  resolveSelectors,
  specSelectors,
  validateSpec,
} from "./spec.js";
export { clampReport, renderAnnotations, type RenderOptions } from "./render.js";
