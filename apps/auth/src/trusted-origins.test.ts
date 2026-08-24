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

  it("allows bare loopback with any port outside production", () => {
    const env = { WEB_ORIGIN: "https://uploads.sh", ENVIRONMENT: "development" };
    expect(isTrustedOrigin("http://localhost:4321", env)).toBe(true);
    expect(isTrustedOrigin("http://127.0.0.1:8788", env)).toBe(true);
  });

  it("trusts the dev web origin via the static WEB_ORIGIN entry, not a regex", () => {
    // #731/#741: portless `*.localhost` and real-TLD OAuth-testing origins are
    // reached same-origin, so the exact web origin is passed as WEB_ORIGIN and
    // covered by the static list — including any worktree prefix. Other
    // `.localhost` / real-TLD hosts (e.g. the retired `auth.*` subdomains) are
    // no longer implicitly trusted.
    const portless = { WEB_ORIGIN: "https://uploads.localhost", ENVIRONMENT: "development" };
    expect(isTrustedOrigin("https://uploads.localhost", portless)).toBe(true);
    expect(isTrustedOrigin("https://auth.uploads.localhost", portless)).toBe(false);

    const worktree = { WEB_ORIGIN: "https://fix-ui.uploads.localhost", ENVIRONMENT: "development" };
    expect(isTrustedOrigin("https://fix-ui.uploads.localhost", worktree)).toBe(true);

    const zone = "uploads.local.buildinternet.dev";
    const realTld = { WEB_ORIGIN: `https://${zone}`, ENVIRONMENT: "development" };
    expect(isTrustedOrigin(`https://${zone}`, realTld)).toBe(true);
    expect(isTrustedOrigin(`https://auth.${zone}`, realTld)).toBe(false);
  });

  it("rejects unrelated and non-web `.localhost` hosts outside production", () => {
    const env = { WEB_ORIGIN: "https://uploads.sh", ENVIRONMENT: "development" };
    expect(isTrustedOrigin("https://evil.example", env)).toBe(false);
    expect(isTrustedOrigin("https://uploads.localhost", env)).toBe(false);
    expect(isTrustedOrigin("https://uploads.local.buildinternet.dev", env)).toBe(false);
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
