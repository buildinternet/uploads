import { describe, expect, it } from "vitest";
import {
  AnnotateSpecError,
  hasSelectors,
  resolveSelectors,
  specSelectors,
  validateSpec,
  type AnnotationSpec,
} from "../src/annotate/index.js";

const validSpec: AnnotationSpec = {
  version: 1,
  annotations: [
    { type: "box", x: 10, y: 20, w: 200, h: 80 },
    { type: "arrow", from: [400, 300], to: [250, 120] },
    { type: "label", text: "New button", target: [250, 120], at: [420, 40] },
    {
      type: "draw",
      points: [
        [1, 2],
        [3, 4],
      ],
    },
    { type: "redact", x: 0, y: 0, w: 100, h: 30, style: "blur" },
    { type: "svg", fragment: "<path d='M0 0'/>" },
  ],
};

describe("validateSpec", () => {
  it("parses a valid full spec", () => {
    const spec = validateSpec(validSpec);
    expect(spec.annotations).toHaveLength(6);
  });

  it("rejects the wrong version", () => {
    expect(() => validateSpec({ version: 2, annotations: [] })).toThrow(AnnotateSpecError);
  });

  it("rejects an unknown annotation type with its index", () => {
    try {
      validateSpec({
        version: 1,
        annotations: [{ type: "box", x: 1, y: 1, w: 1, h: 1 }, { type: "circle" }],
      });
      throw new Error("expected validateSpec to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AnnotateSpecError);
      const errors = (err as AnnotateSpecError).errors;
      expect(errors).toHaveLength(1);
      expect(errors[0].index).toBe(1);
    }
  });

  it("rejects a box missing h", () => {
    try {
      validateSpec({ version: 1, annotations: [{ type: "box", x: 1, y: 1, w: 1 }] });
      throw new Error("expected validateSpec to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AnnotateSpecError);
      expect((err as AnnotateSpecError).errors[0].index).toBe(0);
    }
  });

  it("rejects a box carrying both pixel geometry and a selector", () => {
    try {
      validateSpec({
        version: 1,
        annotations: [{ type: "box", x: 1, y: 1, w: 1, h: 1, selector: "#a" }],
      });
      throw new Error("expected validateSpec to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AnnotateSpecError);
      expect((err as AnnotateSpecError).errors[0].message).toMatch(/ambiguous|both/i);
    }
  });

  it("rejects a draw with fewer than 2 points", () => {
    try {
      validateSpec({ version: 1, annotations: [{ type: "draw", points: [[1, 2]] }] });
      throw new Error("expected validateSpec to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AnnotateSpecError);
      expect((err as AnnotateSpecError).errors[0].index).toBe(0);
    }
  });

  it("rejects an empty annotations array", () => {
    expect(() => validateSpec({ version: 1, annotations: [] })).toThrow(AnnotateSpecError);
  });

  it("rejects an svg fragment containing <script", () => {
    try {
      validateSpec({
        version: 1,
        annotations: [{ type: "svg", fragment: "<script>alert(1)</script>" }],
      });
      throw new Error("expected validateSpec to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AnnotateSpecError);
    }
  });
});

describe("hasSelectors / specSelectors", () => {
  it("reports false and empty list for a pixel-only spec", () => {
    const spec = validateSpec(validSpec);
    expect(hasSelectors(spec)).toBe(false);
    expect(specSelectors(spec)).toEqual([]);
  });

  it("collects distinct selectors in order", () => {
    const spec = validateSpec({
      version: 1,
      annotations: [
        { type: "box", selector: "#a" },
        { type: "redact", selector: "#b" },
        { type: "arrow", selector: "#a" },
      ],
    });
    expect(hasSelectors(spec)).toBe(true);
    expect(specSelectors(spec)).toEqual(["#a", "#b"]);
  });
});

describe("resolveSelectors", () => {
  const boxes = {
    "#a": { x: 10, y: 10, w: 100, h: 50 },
    "#b": { x: 200, y: 200, w: 20, h: 20 },
  };

  it("resolves box/redact selectors to their element box", () => {
    const spec = validateSpec({
      version: 1,
      annotations: [
        { type: "box", selector: "#a" },
        { type: "redact", selector: "#b" },
      ],
    });
    const resolved = resolveSelectors(spec, boxes);
    expect(resolved.annotations[0]).toMatchObject({ x: 10, y: 10, w: 100, h: 50 });
    expect(resolved.annotations[1]).toMatchObject({ x: 200, y: 200, w: 20, h: 20 });
    expect(hasSelectors(resolved)).toBe(false);
  });

  it("resolves an arrow selector to the element's center as `to`", () => {
    const spec = validateSpec({ version: 1, annotations: [{ type: "arrow", selector: "#a" }] });
    const resolved = resolveSelectors(spec, boxes);
    expect(resolved.annotations[0]).toMatchObject({ to: [60, 35], from: [180, -85] });
  });

  it("resolves a label selector to the element's center as `target`", () => {
    const spec = validateSpec({
      version: 1,
      annotations: [{ type: "label", text: "hi", selector: "#b" }],
    });
    const resolved = resolveSelectors(spec, boxes);
    expect(resolved.annotations[0]).toMatchObject({ target: [210, 210] });
  });

  it("throws AnnotateSpecError naming a selector missing from boxes", () => {
    const spec = validateSpec({ version: 1, annotations: [{ type: "box", selector: "#missing" }] });
    try {
      resolveSelectors(spec, {});
      throw new Error("expected resolveSelectors to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AnnotateSpecError);
      expect((err as AnnotateSpecError).message).toContain("#missing");
    }
  });
});
