import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyAuthSecurityHeaders,
  authPageCsp,
  devicePageCsp,
  INVITE_CSP,
  loginHref,
  loginReturnPath,
  resolveSignedInOrigins,
  signedInCsp,
  signedInShellLoginRedirect,
} from "./signed-in-page";

const AUTH = "https://auth.uploads.sh";
const API = "https://api.uploads.sh";

describe("resolveSignedInOrigins", () => {
  it("always resolves the auth origin to same-origin (#731 phase B), regardless of env", () => {
    expect(resolveSignedInOrigins({}).authOrigin).toBe("");
    expect(
      resolveSignedInOrigins({ UPLOADS_API_ORIGIN: "https://api.uploads.sh" }).authOrigin,
    ).toBe("");
  });

  it("always resolves the api origin to the same-origin '/api' prefix (#731 phase D), regardless of env", () => {
    expect(resolveSignedInOrigins({}).apiOrigin).toBe("/api");
    expect(resolveSignedInOrigins({ UPLOADS_API_ORIGIN: "https://api.uploads.sh" }).apiOrigin).toBe(
      "/api",
    );
  });
});

describe("signedInShellLoginRedirect", () => {
  const search = "?path=/settings";
  const pathname = "/account/workspaces/acme/screenshots";

  it("redirects cookie-less account and admin visits", () => {
    expect(
      signedInShellLoginRedirect({
        pathname,
        search,
        allowLocalDemo: false,
        hasCookie: false,
        sessionKind: null,
      }),
    ).toBe("/login?callbackURL=%2Faccount%2Fworkspaces%2Facme%2Fscreenshots%3Fpath%3D%2Fsettings");
    expect(
      signedInShellLoginRedirect({
        pathname: "/admin/users",
        allowLocalDemo: false,
        hasCookie: false,
        sessionKind: null,
      }),
    ).toBe("/login?callbackURL=%2Fadmin%2Fusers");
  });

  it("leaves public pages, local demo, live sessions, and auth outages alone", () => {
    const base = {
      pathname,
      search,
      allowLocalDemo: false,
      hasCookie: false,
      sessionKind: null,
    } as const;
    expect(signedInShellLoginRedirect({ ...base, pathname: "/login" })).toBeNull();
    expect(signedInShellLoginRedirect({ ...base, pathname: "/docs" })).toBeNull();
    expect(signedInShellLoginRedirect({ ...base, allowLocalDemo: true })).toBeNull();
    expect(
      signedInShellLoginRedirect({ ...base, hasCookie: true, sessionKind: "signed_in" }),
    ).toBeNull();
    expect(
      signedInShellLoginRedirect({ ...base, hasCookie: true, sessionKind: "unavailable" }),
    ).toBeNull();
  });

  it("redirects an expired cookie once session resolution says signed_out", () => {
    expect(
      signedInShellLoginRedirect({
        pathname,
        search,
        allowLocalDemo: false,
        hasCookie: true,
        sessionKind: "signed_out",
      }),
    ).toBe("/login?callbackURL=%2Faccount%2Fworkspaces%2Facme%2Fscreenshots%3Fpath%3D%2Fsettings");
  });
});

describe("loginHref / loginReturnPath", () => {
  it("keeps a same-origin account path and query", () => {
    expect(loginReturnPath("/account/workspaces/acme/screenshots?path=/settings")).toBe(
      "/account/workspaces/acme/screenshots?path=/settings",
    );
    expect(loginHref("/account/workspaces/acme/screenshots?path=/settings")).toBe(
      "/login?callbackURL=%2Faccount%2Fworkspaces%2Facme%2Fscreenshots%3Fpath%3D%2Fsettings",
    );
  });

  it("drops /login itself and off-origin values", () => {
    expect(loginReturnPath("/login")).toBeNull();
    expect(loginReturnPath("/login?callbackURL=/account")).toBeNull();
    expect(loginHref("/login")).toBe("/login");
    expect(loginHref("https://evil.example/x")).toBe("/login");
    expect(loginHref("//evil.example")).toBe("/login");
    expect(loginHref(null)).toBe("/login");
  });
});

describe("signed-in / auth CSP builders", () => {
  it("signedInCsp locks down and allows session + API + RUM", () => {
    const csp = signedInCsp(AUTH, API);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`connect-src ${AUTH} ${API}`);
    expect(csp).toContain("'self'");
    expect(csp).toContain("https://cloudflareinsights.com");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("https://static.cloudflareinsights.com");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src data: https:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it("authPageCsp is tighter: auth origin only, data: images", () => {
    const csp = authPageCsp(AUTH);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`connect-src ${AUTH}`);
    expect(csp).toContain("'self'");
    expect(csp).toContain("https://cloudflareinsights.com");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src data:");
    expect(csp).not.toContain("img-src data: https:");
    expect(csp).not.toContain(API);
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("devicePageCsp adds the API origin for inline workspace creation, nothing else", () => {
    const csp = devicePageCsp(AUTH, API);
    expect(csp).toContain(`connect-src ${AUTH} ${API}`);
    // Still an auth page: data: images only, unlike signedInCsp.
    expect(csp).toContain("img-src data:");
    expect(csp).not.toContain("img-src data: https:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'none'");

    // Drift guard: ensure devicePageCsp is authPageCsp with API origin added to connect-src.
    // This prevents silent directive drift that the spot-checks above wouldn't catch.
    const authCsp = authPageCsp(AUTH);
    const expectedDeviceCsp = authCsp.replace(`connect-src ${AUTH}`, `connect-src ${AUTH} ${API}`);
    expect(devicePageCsp(AUTH, API)).toBe(expectedDeviceCsp);
  });

  it("authPageCsp collapses a same-origin auth origin to 'self' (#731 phase B)", () => {
    const csp = authPageCsp("");
    expect(csp).toContain("connect-src 'self' https://cloudflareinsights.com");
    expect(csp).not.toContain("connect-src  ");
  });

  it("devicePageCsp collapses a same-origin auth origin to 'self', keeps the API origin", () => {
    const csp = devicePageCsp("", API);
    expect(csp).toContain(`connect-src 'self' ${API} https://cloudflareinsights.com`);
  });

  it("signedInCsp collapses a same-origin auth origin to 'self', keeps the API origin", () => {
    const csp = signedInCsp("", API);
    expect(csp).toContain(`connect-src 'self' ${API} https://cloudflareinsights.com`);
  });

  it("de-dupes connect-src to a single 'self' when both origins are same-origin", () => {
    const csp = signedInCsp("", "");
    expect(csp).toContain("connect-src 'self' https://cloudflareinsights.com");
    expect(csp).not.toContain("'self' 'self'");
  });

  it("collapses the same-origin api '/api' prefix to 'self' too (#731 phase D)", () => {
    const csp = devicePageCsp("", "/api");
    expect(csp).toContain("connect-src 'self' https://cloudflareinsights.com");
    expect(csp).not.toContain("/api");
  });

  it("de-dupes connect-src to one 'self' when authOrigin is '' and apiOrigin is '/api'", () => {
    const csp = signedInCsp("", "/api");
    expect(csp).toContain("connect-src 'self' https://cloudflareinsights.com");
    expect(csp).not.toContain("'self' 'self'");
  });

  it("INVITE_CSP targets prod API and keeps frame-ancestors", () => {
    expect(INVITE_CSP).toContain("default-src 'none'");
    expect(INVITE_CSP).toContain(`connect-src ${API}`);
    expect(INVITE_CSP).toContain("'self'");
    expect(INVITE_CSP).toContain("https://cloudflareinsights.com");
    expect(INVITE_CSP).toContain("frame-ancestors 'none'");
    expect(INVITE_CSP).toContain("img-src data:");
  });

  it("applyAuthSecurityHeaders matches public-file baseline + page CSP", () => {
    const headers = new Headers();
    const csp = signedInCsp(AUTH, API);
    applyAuthSecurityHeaders(headers, csp);
    expect(headers.get("Content-Security-Policy")).toBe(csp);
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
    expect(headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
    expect(headers.get("Cache-Control")).toBe("no-store");

    const authHeaders = new Headers();
    applyAuthSecurityHeaders(authHeaders, authPageCsp(AUTH));
    expect(authHeaders.get("Content-Security-Policy")).toBe(authPageCsp(AUTH));
    expect(authHeaders.get("X-Frame-Options")).toBe("DENY");
  });

  it("public/_headers /invite* CSP matches INVITE_CSP (single authoritative policy)", () => {
    const headersPath = join(dirname(fileURLToPath(import.meta.url)), "../../public/_headers");
    const text = readFileSync(headersPath, "utf8");
    const line = text.match(/\/invite\*[\s\S]*?^\s*Content-Security-Policy:\s*(.+)$/m);
    expect(line, "expected Content-Security-Policy under /invite* in public/_headers").toBeTruthy();
    expect(line![1].trim()).toBe(INVITE_CSP);
    expect(text).toMatch(/\/invite\*[\s\S]*?X-Frame-Options:\s*DENY/);
    expect(text).toMatch(/\/invite\*[\s\S]*?Cross-Origin-Opener-Policy:\s*same-origin/);
  });
});
