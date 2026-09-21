import { describe, expect, it } from "vitest";
import { pdfPreviewAllowed } from "./pdf-preview-gate";

const allowLimiter = { limit: async () => ({ success: true }) };
const denyLimiter = { limit: async () => ({ success: false }) };
const flagsOn = { getBooleanValue: async () => true };
const flagsOff = { getBooleanValue: async (_key: string, fallback: boolean) => fallback };

function env(over: Record<string, unknown> = {}) {
  return {
    FLAGS: flagsOn,
    POSTER_LIMITER: allowLimiter,
    ...over,
  } as never;
}

describe("pdfPreviewAllowed", () => {
  it("allows when every layer is open", async () => {
    expect(await pdfPreviewAllowed(env(), {}, "acme")).toBe(true);
  });

  it("does not require the MEDIA binding", async () => {
    expect(await pdfPreviewAllowed(env({ MEDIA: undefined }), {}, "acme")).toBe(true);
  });

  it("denies when the workspace opted out", async () => {
    expect(await pdfPreviewAllowed(env(), { pdfPosterEnabled: false }, "acme")).toBe(false);
  });

  it("denies when the rate limiter is exhausted", async () => {
    expect(await pdfPreviewAllowed(env({ POSTER_LIMITER: denyLimiter }), {}, "acme")).toBe(false);
  });

  it("fails closed when Flagship evaluation falls back to the default", async () => {
    expect(await pdfPreviewAllowed(env({ FLAGS: flagsOff }), {}, "acme")).toBe(false);
  });

  it("fails closed when the FLAGS binding is absent", async () => {
    expect(await pdfPreviewAllowed(env({ FLAGS: undefined }), {}, "acme")).toBe(false);
  });

  it("fails closed when the POSTER_LIMITER binding is absent", async () => {
    expect(await pdfPreviewAllowed(env({ POSTER_LIMITER: undefined }), {}, "acme")).toBe(false);
  });

  it("fails closed when Flagship evaluation throws", async () => {
    const flagsThrows = {
      getBooleanValue: async () => {
        throw new Error("flagship unreachable");
      },
    };
    expect(await pdfPreviewAllowed(env({ FLAGS: flagsThrows }), {}, "acme")).toBe(false);
  });

  it("checks the workspace opt-out before spending a limiter token", async () => {
    let called = false;
    const counting = {
      limit: async () => {
        called = true;
        return { success: true };
      },
    };
    await pdfPreviewAllowed(env({ POSTER_LIMITER: counting }), { pdfPosterEnabled: false }, "acme");
    expect(called).toBe(false);
  });
});
