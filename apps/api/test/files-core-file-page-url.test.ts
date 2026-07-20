import { describe, expect, it } from "vitest";
import { filePageUrl } from "../src/files-core";

// `Env` is a global ambient type (apps/api/src/env.d.ts) — no import needed.
const env = { WEB_ORIGIN: "https://uploads.sh" } as unknown as Env;

describe("filePageUrl", () => {
  it("builds /f/<workspace>/<key> against WEB_ORIGIN", () => {
    expect(filePageUrl(env, "acme", "gh/acme/web/pull/12/hero.png")).toBe(
      "https://uploads.sh/f/acme/gh/acme/web/pull/12/hero.png",
    );
  });

  it("encodes each path segment but keeps slashes between them", () => {
    expect(filePageUrl(env, "acme", "gh/o/r/pull/1/a b.png")).toBe(
      "https://uploads.sh/f/acme/gh/o/r/pull/1/a%20b.png",
    );
  });

  it("trims a trailing slash on WEB_ORIGIN", () => {
    const slashy = { WEB_ORIGIN: "https://uploads.sh/" } as unknown as Env;
    expect(filePageUrl(slashy, "acme", "x.png")).toBe("https://uploads.sh/f/acme/x.png");
  });
});
