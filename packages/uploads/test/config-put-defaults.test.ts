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
