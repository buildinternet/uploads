/**
 * Annotation spec: types, validation, and selector resolution.
 *
 * NOT exported outside this module directly — only `index.ts` re-exports
 * these. Keep the public surface narrow so the renderer stays swappable
 * (see the module header in `index.ts`).
 */

export type Point = [number, number];

export interface BoxAnnotation {
  type: "box";
  x: number;
  y: number;
  w: number;
  h: number;
  color?: string;
  selector?: string;
}

export interface ArrowAnnotation {
  type: "arrow";
  from: Point;
  to: Point;
  color?: string;
  selector?: string;
}

export interface LabelAnnotation {
  type: "label";
  text: string;
  target?: Point;
  at?: Point;
  color?: string;
  selector?: string;
}

export interface DrawAnnotation {
  type: "draw";
  points: Point[];
  color?: string;
}

export interface RedactAnnotation {
  type: "redact";
  x: number;
  y: number;
  w: number;
  h: number;
  style?: "blur" | "solid";
  selector?: string;
}

export interface SvgAnnotation {
  type: "svg";
  fragment: string;
}

export type Annotation =
  | BoxAnnotation
  | ArrowAnnotation
  | LabelAnnotation
  | DrawAnnotation
  | RedactAnnotation
  | SvgAnnotation;

export interface AnnotationSpec {
  version: 1;
  annotations: Annotation[];
}

export interface SpecError {
  index: number | null;
  message: string;
}

/** Thrown by `validateSpec` and `resolveSelectors`; carries every collected error. */
export class AnnotateSpecError extends Error {
  readonly errors: SpecError[];

  constructor(errors: SpecError[]) {
    super(
      errors
        .map((e) => (e.index === null ? e.message : `annotations[${e.index}]: ${e.message}`))
        .join("; "),
    );
    this.name = "AnnotateSpecError";
    this.errors = errors;
  }
}

type Box = { x: number; y: number; w: number; h: number };

const GEOMETRIC_TYPES = new Set(["box", "arrow", "label", "redact"]);

/**
 * Default placement offsets used when a spec omits an explicit position —
 * kept together so "where things land by default" has one home. Units are
 * image pixels; `labelAt` is additionally multiplied by the render scale.
 */
export const DEFAULT_PLACEMENT = {
  /** Selector-only arrow: tail offset from the target center (resolveSelectors). */
  arrowFrom: [120, -120] as const,
  /** Label with a target but no `at`: bubble offset above-right (renderLabel). */
  labelAt: [30, -90] as const,
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isPoint(v: unknown): v is Point {
  return Array.isArray(v) && v.length === 2 && isFiniteNumber(v[0]) && isFiniteNumber(v[1]);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Validates one raw annotation, pushing any `SpecError`s onto `errors`. */
function validateAnnotation(raw: unknown, index: number, errors: SpecError[]): void {
  const fail = (message: string) => errors.push({ index, message });

  if (typeof raw !== "object" || raw === null) {
    fail("must be an object");
    return;
  }
  const a = raw as Record<string, unknown>;
  const type = a.type;
  if (typeof type !== "string") {
    fail("missing or non-string type");
    return;
  }

  const hasSelector = typeof a.selector === "string" && a.selector.length > 0;
  const hasPixelGeometry = (() => {
    switch (type) {
      case "box":
      case "redact":
        return hasOwn(a, "x") || hasOwn(a, "y") || hasOwn(a, "w") || hasOwn(a, "h");
      // `from` is deliberately allowed alongside a selector: the selector
      // resolves the arrow's head (`to`), and an explicit `from` overrides
      // the default tail placement (see resolveSelectors).
      case "arrow":
        return hasOwn(a, "to");
      case "label":
        return hasOwn(a, "target");
      default:
        return false;
    }
  })();

  if (GEOMETRIC_TYPES.has(type) && hasSelector && hasPixelGeometry) {
    fail("ambiguous: both pixel geometry and a selector are present, pick one");
    return;
  }

  const requireBoxFields = () => {
    if (hasSelector) return;
    if (
      !isFiniteNumber(a.x) ||
      !isFiniteNumber(a.y) ||
      !isFiniteNumber(a.w) ||
      !isFiniteNumber(a.h)
    ) {
      fail(`${type} requires finite x, y, w, h (or a selector)`);
    }
  };

  switch (type) {
    case "box": {
      requireBoxFields();
      break;
    }
    case "redact": {
      requireBoxFields();
      if (hasOwn(a, "style") && a.style !== "blur" && a.style !== "solid") {
        fail('redact style must be "blur" or "solid"');
      }
      break;
    }
    case "arrow": {
      if (hasSelector) break;
      if (!isPoint(a.from) || !isPoint(a.to)) {
        fail("arrow requires from/to points (or a selector)");
      }
      break;
    }
    case "label": {
      if (typeof a.text !== "string" || a.text.length === 0) {
        fail("label requires non-empty text");
      }
      if (hasSelector) break;
      if (hasOwn(a, "target") && !isPoint(a.target)) {
        fail("label target must be a point");
      }
      if (hasOwn(a, "at") && !isPoint(a.at)) {
        fail("label at must be a point");
      }
      break;
    }
    case "draw": {
      if (!Array.isArray(a.points) || a.points.length < 2 || !a.points.every(isPoint)) {
        fail("draw requires at least 2 points");
      }
      break;
    }
    case "svg": {
      if (typeof a.fragment !== "string" || a.fragment.length === 0) {
        fail("svg requires a non-empty fragment");
      } else if (/<script/i.test(a.fragment)) {
        fail("svg fragment must not contain <script");
      } else if (/\bhref\s*=|\burl\s*\(/i.test(a.fragment)) {
        // librsvg resolves href/xlink:href and CSS url() references, which
        // has been an arbitrary-file-read vector (e.g. CVE-2023-38633) —
        // reject external/local references outright in the escape hatch.
        fail("svg fragment must not reference external resources (href= or url())");
      }
      break;
    }
    default:
      fail(`unknown annotation type "${String(type)}"`);
  }
}

/** Throws AnnotateSpecError (carries errors: SpecError[]) on invalid input. */
export function validateSpec(json: unknown): AnnotationSpec {
  const errors: SpecError[] = [];

  if (typeof json !== "object" || json === null) {
    throw new AnnotateSpecError([{ index: null, message: "spec must be an object" }]);
  }
  const raw = json as Record<string, unknown>;

  if (raw.version !== 1) {
    errors.push({ index: null, message: `version must be 1, got ${JSON.stringify(raw.version)}` });
  }
  if (!Array.isArray(raw.annotations) || raw.annotations.length === 0) {
    errors.push({ index: null, message: "annotations must be a non-empty array" });
  }

  if (errors.length > 0) throw new AnnotateSpecError(errors);

  const annotations = raw.annotations as unknown[];
  annotations.forEach((a, i) => validateAnnotation(a, i, errors));

  if (errors.length > 0) throw new AnnotateSpecError(errors);

  return { version: 1, annotations: annotations as Annotation[] };
}

/** True if any annotation still carries an unresolved selector. */
export function hasSelectors(spec: AnnotationSpec): boolean {
  return spec.annotations.some((a) => "selector" in a && typeof a.selector === "string");
}

/** All distinct selectors in the spec, in order. */
export function specSelectors(spec: AnnotationSpec): string[] {
  const seen: string[] = [];
  for (const a of spec.annotations) {
    const sel = "selector" in a ? a.selector : undefined;
    if (typeof sel === "string" && !seen.includes(sel)) seen.push(sel);
  }
  return seen;
}

function center(box: Box): Point {
  return [box.x + box.w / 2, box.y + box.h / 2];
}

/**
 * Replace selector targeting with pixel geometry using measured boxes keyed
 * by selector. Throws AnnotateSpecError naming any selector missing from
 * boxes.
 */
export function resolveSelectors(spec: AnnotationSpec, boxes: Record<string, Box>): AnnotationSpec {
  const errors: SpecError[] = [];

  const resolved = spec.annotations.map((a, index): Annotation => {
    const sel = "selector" in a ? a.selector : undefined;
    if (typeof sel !== "string") return a;

    const box = boxes[sel];
    if (!box) {
      errors.push({ index, message: `selector "${sel}" was not found among the measured boxes` });
      return a;
    }

    switch (a.type) {
      case "box":
      case "redact": {
        const { selector: _selector, ...rest } = a;
        return { ...rest, x: box.x, y: box.y, w: box.w, h: box.h };
      }
      case "arrow": {
        const { selector: _selector, ...rest } = a;
        const to = center(box);
        // A selector-only arrow points at the element from its upper right;
        // the renderer clamps if that lands outside the image.
        const from =
          rest.from ??
          ([
            to[0] + DEFAULT_PLACEMENT.arrowFrom[0],
            to[1] + DEFAULT_PLACEMENT.arrowFrom[1],
          ] as Point);
        return { ...rest, from, to };
      }
      case "label": {
        const { selector: _selector, ...rest } = a;
        return { ...rest, target: center(box) };
      }
      default:
        return a;
    }
  });

  if (errors.length > 0) throw new AnnotateSpecError(errors);

  return { version: 1, annotations: resolved };
}
