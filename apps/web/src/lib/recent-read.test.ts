import { afterEach, describe, expect, it } from "vitest";
import { clearRecentReads, RECENT_READ_TTL_MS, recentRead } from "./recent-read";

afterEach(() => {
  clearRecentReads();
});

describe("recentRead", () => {
  it("shares one load across callers inside the window", async () => {
    let t = 0;
    let calls = 0;
    const load = async () => ++calls;
    const now = () => t;
    expect(await recentRead("k", load, undefined, now)).toBe(1);
    t = RECENT_READ_TTL_MS - 1;
    expect(await recentRead("k", load, undefined, now)).toBe(1);
    t = RECENT_READ_TTL_MS;
    expect(await recentRead("k", load, undefined, now)).toBe(2);
  });

  it("drops results keep rejects and failed loads", async () => {
    let calls = 0;
    const bad = async () => ({ ok: false, n: ++calls });
    await recentRead("k", bad, (r) => r.ok);
    await recentRead("k", bad, (r) => r.ok);
    expect(calls).toBe(2);

    const failing = async (): Promise<number> => {
      calls += 1;
      throw new Error("down");
    };
    await expect(recentRead("f", failing)).rejects.toThrow("down");
    await expect(recentRead("f", failing)).rejects.toThrow("down");
    expect(calls).toBe(4);
  });

  it("forgets everything on clear", async () => {
    let calls = 0;
    await recentRead("k", async () => ++calls);
    clearRecentReads();
    await recentRead("k", async () => ++calls);
    expect(calls).toBe(2);
  });
});
