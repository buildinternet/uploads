import { describe, expect, it } from "vitest";
import { authTrustedOrigins, isTrustedOrigin } from "./trusted-origins";

describe("authTrustedOrigins", () => {
  it("defaults to https://uploads.sh", () => {
    expect(authTrustedOrigins({})).toEqual(["https://uploads.sh"]);
  });

  it("uses WEB_ORIGIN when set", () => {
    expect(authTrustedOrigins({ WEB_ORIGIN: "https://staging.uploads.sh" })).toEqual([
      "https://staging.uploads.sh",
    ]);
  });

  it("merges comma-separated BETTER_AUTH_TRUSTED_ORIGINS, de-duplicated", () => {
    expect(
      authTrustedOrigins({
        WEB_ORIGIN: "https://uploads.sh",
        BETTER_AUTH_TRUSTED_ORIGINS: "https://uploads.sh, https://extra.example ,,",
      }),
    ).toEqual(["https://uploads.sh", "https://extra.example"]);
  });
});

describe("isTrustedOrigin", () => {
  const prodEnv = { WEB_ORIGIN: "https://uploads.sh", ENVIRONMENT: "production" };

  it("allows the configured web origin", () => {
    expect(isTrustedOrigin("https://uploads.sh", prodEnv)).toBe(true);
  });

  it("rejects an untrusted origin in production", () => {
    expect(isTrustedOrigin("https://evil.example", prodEnv)).toBe(false);
  });

  it("rejects localhost in production", () => {
    expect(isTrustedOrigin("http://localhost:4321", prodEnv)).toBe(false);
  });

  it("allows localhost with any port outside production", () => {
    const env = { WEB_ORIGIN: "https://uploads.sh", ENVIRONMENT: "development" };
    expect(isTrustedOrigin("http://localhost:4321", env)).toBe(true);
    expect(isTrustedOrigin("http://127.0.0.1:8788", env)).toBe(true);
  });

  it("allows portless *.localhost origins outside production", () => {
    const env = { WEB_ORIGIN: "https://uploads.sh", ENVIRONMENT: "development" };
    expect(isTrustedOrigin("https://uploads.localhost", env)).toBe(true);
    expect(isTrustedOrigin("https://auth.uploads.localhost", env)).toBe(true);
    expect(isTrustedOrigin("https://fix-ui.auth.uploads.localhost", env)).toBe(true);
    expect(isTrustedOrigin("http://uploads.localhost:1355", env)).toBe(true);
  });

  it("allows the real-TLD portless OAuth zone outside production only", () => {
    const env = { WEB_ORIGIN: "https://uploads.sh", ENVIRONMENT: "development" };
    const zone = "uploads.local.buildinternet.dev";
    expect(isTrustedOrigin(`https://${zone}`, env)).toBe(true);
    expect(isTrustedOrigin(`https://auth.${zone}`, env)).toBe(true);
    expect(isTrustedOrigin(`https://fix-ui.auth.${zone}`, env)).toBe(true);
    expect(isTrustedOrigin(`http://auth.${zone}`, env)).toBe(false);
    expect(isTrustedOrigin("https://evil-uploads.local.buildinternet.dev", env)).toBe(false);
    // Never under uploads.sh — the local zone must not share prod's
    // registrable domain (cookie scope).
    expect(isTrustedOrigin("https://auth.local.uploads.sh", env)).toBe(false);
    expect(isTrustedOrigin(`https://auth.${zone}`, prodEnv)).toBe(false);
  });

  it("rejects unrelated hosts outside production", () => {
    const env = { WEB_ORIGIN: "https://uploads.sh", ENVIRONMENT: "development" };
    expect(isTrustedOrigin("https://evil.example", env)).toBe(false);
  });

  it("allows extra trusted origins from env in any environment", () => {
    const env = {
      WEB_ORIGIN: "https://uploads.sh",
      ENVIRONMENT: "production",
      BETTER_AUTH_TRUSTED_ORIGINS: "https://preview.uploads.sh",
    };
    expect(isTrustedOrigin("https://preview.uploads.sh", env)).toBe(true);
  });
});
