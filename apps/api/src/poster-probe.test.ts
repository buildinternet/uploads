import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { mediabunnyProbe } from "./poster";

const clip = new Uint8Array(
  readFileSync(fileURLToPath(new NodeURL("../test/fixtures/sample-portrait.mp4", import.meta.url))),
);

describe("mediabunnyProbe", () => {
  it("reads duration without a decoder", async () => {
    const result = await mediabunnyProbe().probe(clip);
    expect(result).not.toBeNull();
    expect(result!.durationSeconds).toBeGreaterThan(0);
  });

  // THE load-bearing assertion. The fixture is coded 1920x1080 (landscape)
  // with rotation=-90, so it DISPLAYS as 1080x1920 portrait. If getDisplay*
  // returns the coded dimensions instead, posterImageWidth would classify
  // every rotated phone clip as landscape — and the fix would be to reinstate
  // the axis swap removed from Task 2. Assert the corrected orientation.
  it("returns rotation-corrected display dimensions, not coded ones", async () => {
    const result = await mediabunnyProbe().probe(clip);
    expect(result!.dimensions).toEqual({ width: 1080, height: 1920 });
  });

  it("returns null for bytes that are not a media container", async () => {
    expect(await mediabunnyProbe().probe(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it("returns null rather than throwing on a truncated file", async () => {
    expect(await mediabunnyProbe().probe(clip.slice(0, 40))).toBeNull();
  });
});
