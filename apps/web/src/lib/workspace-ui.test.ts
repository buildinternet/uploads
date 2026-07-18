import { describe, expect, it } from "vitest";
import { safeSameOriginPath } from "./workspace-ui";

describe("safeSameOriginPath", () => {
  it("accepts an absolute in-app path with query and hash", () => {
    expect(safeSameOriginPath("/oauth/consent?client_id=c1&sig=x#top")).toBe(
      "/oauth/consent?client_id=c1&sig=x#top",
    );
  });

  it("rejects everything that could navigate off-origin", () => {
    expect(safeSameOriginPath(undefined)).toBeNull();
    expect(safeSameOriginPath("")).toBeNull();
    expect(safeSameOriginPath("relative/path")).toBeNull();
    expect(safeSameOriginPath("https://evil.example/x")).toBeNull();
    // Protocol-relative and the backslash variant browsers normalize to it.
    expect(safeSameOriginPath("//evil.example")).toBeNull();
    expect(safeSameOriginPath("/\\evil.example")).toBeNull();
    // Defense in depth: a raw embedded scheme is rejected even inside the
    // query — legitimate producers percent-encode (the consent page does).
    expect(safeSameOriginPath("/ok?u=https://evil.example")).toBeNull();
  });
});
