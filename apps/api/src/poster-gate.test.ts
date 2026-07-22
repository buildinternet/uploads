import { describe, expect, it } from "vitest";
import { posterGenerationAllowed } from "./poster";

const allowLimiter = { limit: async () => ({ success: true }) };
const denyLimiter = { limit: async () => ({ success: false }) };
const flagsOn = { getBooleanValue: async () => true };
const flagsOff = { getBooleanValue: async (_k: string, def: boolean) => def };

function env(over: Record<string, unknown> = {}) {
  return {
    MEDIA: {},
    FLAGS: flagsOn,
    POSTER_LIMITER: allowLimiter,
    ...over,
  } as never;
}

describe("posterGenerationAllowed", () => {
  it("allows when every layer is open", async () => {
    expect(await posterGenerationAllowed(env(), {}, "acme")).toBe(true);
  });

  it("denies when the MEDIA binding is absent (hard kill switch)", async () => {
    expect(await posterGenerationAllowed(env({ MEDIA: undefined }), {}, "acme")).toBe(false);
  });

  it("denies when the workspace opted out", async () => {
    expect(await posterGenerationAllowed(env(), { videoPosterEnabled: false }, "acme")).toBe(false);
  });

  it("denies when the rate limiter is exhausted", async () => {
    expect(await posterGenerationAllowed(env({ POSTER_LIMITER: denyLimiter }), {}, "acme")).toBe(
      false,
    );
  });

  it("fails closed when Flagship evaluation falls back to the default", async () => {
    expect(await posterGenerationAllowed(env({ FLAGS: flagsOff }), {}, "acme")).toBe(false);
  });

  it("fails closed when the FLAGS binding is absent entirely", async () => {
    expect(await posterGenerationAllowed(env({ FLAGS: undefined }), {}, "acme")).toBe(false);
  });

  it("fails closed when the POSTER_LIMITER binding is absent entirely", async () => {
    expect(await posterGenerationAllowed(env({ POSTER_LIMITER: undefined }), {}, "acme")).toBe(
      false,
    );
  });

  it("fails closed when Flagship evaluation throws", async () => {
    const flagsThrows = {
      getBooleanValue: async () => {
        throw new Error("flagship unreachable");
      },
    };
    expect(await posterGenerationAllowed(env({ FLAGS: flagsThrows }), {}, "acme")).toBe(false);
  });

  it("checks cheap local gates before spending a limiter token", async () => {
    let called = false;
    const counting = {
      limit: async () => {
        called = true;
        return { success: true };
      },
    };
    await posterGenerationAllowed(
      env({ POSTER_LIMITER: counting }),
      { videoPosterEnabled: false },
      "acme",
    );
    expect(called).toBe(false);
  });
});
