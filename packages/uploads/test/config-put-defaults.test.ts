import { afterEach, describe, expect, it } from "vitest";
import { resolvePutDefaults } from "../src/config-file.js";

describe("resolvePutDefaults noAutoMeta", () => {
  const prev = process.env.UPLOADS_NO_AUTO_META;
  afterEach(() => {
    if (prev === undefined) delete process.env.UPLOADS_NO_AUTO_META;
    else process.env.UPLOADS_NO_AUTO_META = prev;
  });

  it("is undefined by default (auto stays on)", () => {
    delete process.env.UPLOADS_NO_AUTO_META;
    expect(resolvePutDefaults({}).noAutoMeta).toBeUndefined();
  });

  it("reads UPLOADS_NO_AUTO_META=1 from env", () => {
    process.env.UPLOADS_NO_AUTO_META = "1";
    expect(resolvePutDefaults({}).noAutoMeta).toBe(true);
  });
});

describe("resolvePutDefaults noNudge (issue #393)", () => {
  const prev = process.env.UPLOADS_NO_NUDGE;
  afterEach(() => {
    if (prev === undefined) delete process.env.UPLOADS_NO_NUDGE;
    else process.env.UPLOADS_NO_NUDGE = prev;
  });

  it("is undefined by default (nudge stays on)", () => {
    delete process.env.UPLOADS_NO_NUDGE;
    expect(resolvePutDefaults({}).noNudge).toBeUndefined();
  });

  it("reads UPLOADS_NO_NUDGE=1 from env", () => {
    process.env.UPLOADS_NO_NUDGE = "1";
    expect(resolvePutDefaults({}).noNudge).toBe(true);
  });

  it("reads UPLOADS_NO_NUDGE=1 from a config/env-file layer (same key, put config path)", () => {
    delete process.env.UPLOADS_NO_NUDGE;
    const fromUser = { UPLOADS_NO_NUDGE: "1" } as const;
    expect(resolvePutDefaults(undefined, { fromEnvFile: {}, fromUser }).noNudge).toBe(true);
  });
});
