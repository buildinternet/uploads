import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { runAnnotate } from "../src/commands/annotate.js";

async function syntheticPng(width = 100, height = 80): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 240, g: 240, b: 240 } },
  })
    .png()
    .toBuffer();
}

function specJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    annotations: [{ type: "box", x: 5, y: 5, w: 10, h: 10 }],
    ...overrides,
  });
}

describe("runAnnotate", () => {
  let dir: string;
  let imagePath: string;
  let logs: string[];
  let errs: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "uploads-annotate-"));
    imagePath = join(dir, "shot.png");
    writeFileSync(imagePath, await syntheticPng());
    logs = [];
    errs = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      logs.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      errs.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("happy path writes an annotated PNG next to the input by default", async () => {
    const specPath = join(dir, "spec.json");
    writeFileSync(specPath, specJson());

    const code = await runAnnotate([imagePath, "--spec", specPath]);

    expect(code).toBe(0);
    const outPath = join(dir, "shot.annotated.png");
    expect(existsSync(outPath)).toBe(true);
    const meta = await sharp(readFileSync(outPath)).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(80);
  });

  it("writes to an explicit --out path", async () => {
    const specPath = join(dir, "spec.json");
    writeFileSync(specPath, specJson());
    const outPath = join(dir, "custom.png");

    const code = await runAnnotate([imagePath, "--spec", specPath, "--out", outPath]);

    expect(code).toBe(0);
    expect(existsSync(outPath)).toBe(true);
  });

  it("reads the spec from stdin when --spec -", async () => {
    const spec = specJson();
    const readStdin = vi.fn(async () => spec);

    const code = await runAnnotate([imagePath, "--spec", "-"], false, readStdin);

    expect(code).toBe(0);
    expect(readStdin).toHaveBeenCalled();
  });

  it("rejects a selector-bearing spec with the documented usage message", async () => {
    const specPath = join(dir, "spec.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        version: 1,
        annotations: [{ type: "box", selector: "#foo" }],
      }),
    );

    await expect(runAnnotate([imagePath, "--spec", specPath])).rejects.toThrow(
      'annotate works on pixels; selectors need "uploads screenshot --annotate" (live page required)',
    );
  });

  it("rejects an invalid spec, listing indexed errors", async () => {
    const specPath = join(dir, "spec.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        version: 1,
        annotations: [{ type: "box", x: 1, y: 1, w: 10 }],
      }),
    );

    const code = await runAnnotate([imagePath, "--spec", specPath]);

    expect(code).toBe(1);
    expect(errs.join("")).toMatch(/annotations\[0\]:/);
  });

  it("surfaces clamp warnings on stderr", async () => {
    const specPath = join(dir, "spec.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        version: 1,
        annotations: [{ type: "box", x: 5000, y: 5000, w: 10, h: 10 }],
      }),
    );

    const code = await runAnnotate([imagePath, "--spec", specPath]);

    expect(code).toBe(0);
    expect(errs.join("")).toMatch(/clamped/);
  });

  it("--format json prints out/width/height/warnings", async () => {
    const specPath = join(dir, "spec.json");
    writeFileSync(specPath, specJson());

    const code = await runAnnotate([imagePath, "--spec", specPath, "--format", "json"]);

    expect(code).toBe(0);
    const printed = JSON.parse(logs.join(""));
    expect(printed).toMatchObject({ width: 100, height: 80, warnings: [] });
    expect(typeof printed.out).toBe("string");
  });

  it("--seed is accepted", async () => {
    const specPath = join(dir, "spec.json");
    writeFileSync(specPath, specJson());

    const code = await runAnnotate([imagePath, "--spec", specPath, "--seed", "42"]);

    expect(code).toBe(0);
  });

  it("requires --spec", async () => {
    await expect(runAnnotate([imagePath])).rejects.toThrow("--spec is required");
  });

  it("requires an image argument", async () => {
    const code = await runAnnotate([]);
    expect(code).toBe(2);
  });
});
