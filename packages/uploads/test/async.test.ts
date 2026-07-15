import { describe, expect, it } from "vitest";
import { mapBounded } from "../src/async.js";

describe("mapBounded", () => {
  it("preserves input order under concurrency", async () => {
    const delays = [30, 5, 15, 1];
    const started: number[] = [];
    const result = await mapBounded(delays, 2, async (ms, index) => {
      started.push(index);
      await new Promise((r) => setTimeout(r, ms));
      return index * 10;
    });
    expect(result).toEqual([0, 10, 20, 30]);
    // With concurrency 2, the first two indices start before later ones finish.
    expect(started.slice(0, 2).sort()).toEqual([0, 1]);
  });

  it("handles empty input", async () => {
    expect(await mapBounded([], 4, async (v) => v)).toEqual([]);
  });

  it("caps concurrency at the input length", async () => {
    let max = 0;
    let inFlight = 0;
    await mapBounded([1, 2, 3], 100, async (v) => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return v;
    });
    expect(max).toBe(3);
  });
});
