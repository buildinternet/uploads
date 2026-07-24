import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  AnnotateSpecError,
  clampReport,
  renderAnnotations,
  type AnnotationSpec,
} from "../src/annotate/index.js";

const goldensDir = fileURLToPath(new URL("./goldens/annotate/", import.meta.url));

async function syntheticBase(width = 800, height = 600): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 245, g: 245, b: 248 },
    },
  })
    .png()
    .toBuffer();
}

function goldenPath(name: string): string {
  return `${goldensDir}${name}`;
}

async function assertGolden(name: string, png: Buffer): Promise<void> {
  const path = goldenPath(name);
  if (process.env.UPDATE_GOLDENS) {
    if (!existsSync(goldensDir)) mkdirSync(goldensDir, { recursive: true });
    writeFileSync(path, png);
    return;
  }
  if (!existsSync(path)) {
    throw new Error(`missing golden ${name}; run with UPDATE_GOLDENS=1 to create it`);
  }
  const expected = readFileSync(path);
  expect(png.equals(expected)).toBe(true);
}

describe("renderAnnotations", () => {
  it("returns a PNG buffer with the same dimensions as the input", async () => {
    const base = await syntheticBase(800, 600);
    const spec: AnnotationSpec = {
      version: 1,
      annotations: [{ type: "box", x: 40, y: 40, w: 200, h: 100 }],
    };
    const png = await renderAnnotations(base, spec);
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(600);
    expect(meta.format).toBe("png");
  });

  it("is deterministic: two renders with the same seed are byte-identical", async () => {
    const base = await syntheticBase(800, 600);
    const spec: AnnotationSpec = {
      version: 1,
      annotations: [
        { type: "box", x: 40, y: 40, w: 200, h: 100 },
        { type: "arrow", from: [400, 300], to: [250, 120] },
        { type: "label", text: "New button", target: [250, 120], at: [420, 40] },
      ],
    };
    const a = await renderAnnotations(base, spec);
    const b = await renderAnnotations(base, spec);
    expect(a.equals(b)).toBe(true);
  });

  it("matches the box golden", async () => {
    const base = await syntheticBase();
    const spec: AnnotationSpec = {
      version: 1,
      annotations: [{ type: "box", x: 60, y: 60, w: 240, h: 140 }],
    };
    const png = await renderAnnotations(base, spec);
    await assertGolden("box.png", png);
  });

  it("matches the arrow golden", async () => {
    const base = await syntheticBase();
    const spec: AnnotationSpec = {
      version: 1,
      annotations: [{ type: "arrow", from: [500, 400], to: [250, 150] }],
    };
    const png = await renderAnnotations(base, spec);
    await assertGolden("arrow.png", png);
  });

  it("matches the label golden", async () => {
    const base = await syntheticBase();
    const spec: AnnotationSpec = {
      version: 1,
      annotations: [
        { type: "label", text: "Fix this pending row", target: [250, 150], at: [420, 40] },
      ],
    };
    const png = await renderAnnotations(base, spec);
    await assertGolden("label.png", png);
  });

  it("matches the draw golden", async () => {
    const base = await syntheticBase();
    const points: [number, number][] = [];
    for (let x = 30; x <= 300; x += 4) {
      const t = (x - 30) / (300 - 30);
      points.push([x, 300 + Math.sin(t * Math.PI * 4) * 20]);
    }
    const spec: AnnotationSpec = {
      version: 1,
      annotations: [{ type: "draw", points }],
    };
    const png = await renderAnnotations(base, spec);
    await assertGolden("draw.png", png);
  });

  it("matches the redact-solid golden", async () => {
    const base = await syntheticBase();
    const spec: AnnotationSpec = {
      version: 1,
      annotations: [{ type: "redact", x: 400, y: 400, w: 200, h: 60, style: "solid" }],
    };
    const png = await renderAnnotations(base, spec);
    await assertGolden("redact-solid.png", png);
  });

  it("matches the redact-blur golden", async () => {
    const base = await syntheticBase();
    const spec: AnnotationSpec = {
      version: 1,
      annotations: [{ type: "redact", x: 400, y: 400, w: 200, h: 60, style: "blur" }],
    };
    const png = await renderAnnotations(base, spec);
    await assertGolden("redact-blur.png", png);
  });

  it("matches the svg fragment golden", async () => {
    const base = await syntheticBase();
    const spec: AnnotationSpec = {
      version: 1,
      annotations: [
        {
          type: "svg",
          fragment:
            '<circle cx="400" cy="300" r="40" fill="none" stroke="#e11d48" stroke-width="4"/>',
        },
      ],
    };
    const png = await renderAnnotations(base, spec);
    await assertGolden("svg.png", png);
  });

  it("matches the composite golden combining every annotation type", async () => {
    const base = await syntheticBase(1200, 800);
    const spec: AnnotationSpec = {
      version: 1,
      annotations: [
        { type: "box", x: 900, y: 80, w: 240, h: 160 },
        { type: "arrow", from: [500, 470], to: [790, 445] },
        { type: "label", text: "Fix this pending row", target: [500, 400], at: [520, 320] },
        {
          type: "draw",
          points: [
            [30, 160],
            [70, 172],
            [110, 152],
            [150, 168],
            [190, 158],
          ],
        },
        { type: "redact", x: 748, y: 380, w: 110, h: 34, style: "blur" },
        {
          type: "svg",
          fragment:
            '<circle cx="1080" cy="700" r="30" fill="none" stroke="#0f172a" stroke-width="3"/>',
        },
      ],
    };
    const png = await renderAnnotations(base, spec);
    await assertGolden("composite.png", png);
  });

  it("throws when the spec still carries a selector", async () => {
    const base = await syntheticBase();
    const spec: AnnotationSpec = {
      version: 1,
      annotations: [{ type: "box", selector: "#thing" } as any],
    };
    await expect(renderAnnotations(base, spec)).rejects.toThrow(AnnotateSpecError);
  });

  it("clamps out-of-bounds geometry and renders successfully", async () => {
    const base = await syntheticBase(800, 600);
    const spec: AnnotationSpec = {
      version: 1,
      annotations: [{ type: "box", x: 700, y: 500, w: 400, h: 400 }],
    };
    const png = await renderAnnotations(base, spec);
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(600);
  });
});

describe("clampReport", () => {
  it("names the index of out-of-bounds annotations", () => {
    const spec: AnnotationSpec = {
      version: 1,
      annotations: [
        { type: "box", x: 40, y: 40, w: 100, h: 100 },
        { type: "box", x: 700, y: 500, w: 400, h: 400 },
      ],
    };
    const warnings = clampReport(spec, 800, 600);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("annotations[1]");
  });

  it("returns no warnings for an in-bounds spec", () => {
    const spec: AnnotationSpec = {
      version: 1,
      annotations: [{ type: "box", x: 40, y: 40, w: 100, h: 100 }],
    };
    expect(clampReport(spec, 800, 600)).toEqual([]);
  });
});
