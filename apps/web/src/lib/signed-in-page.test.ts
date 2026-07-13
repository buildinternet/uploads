import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyAuthSecurityHeaders, authPageCsp, INVITE_CSP, signedInCsp } from "./signed-in-page";

const AUTH = "https://auth.uploads.sh";
const API = "https://api.uploads.sh";

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
