import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UploadsError } from "../src/errors.js";
import {
  captureScreenshot,
  classifyTarget,
  isPrivateOrLocalHost,
  parseViewport,
  parseWaitUntil,
} from "../src/screenshot.js";

describe("parseViewport", () => {
  it("defaults to 1280x800@2", () => {
    expect(parseViewport(undefined)).toEqual({ width: 1280, height: 800, deviceScaleFactor: 2 });
  });

  it("parses WIDTHxHEIGHT with no scale (defaults to 1x)", () => {
    expect(parseViewport("1000x700")).toEqual({ width: 1000, height: 700, deviceScaleFactor: 1 });
  });

  it("parses an explicit @Nx scale", () => {
    expect(parseViewport("1280x800@2x")).toEqual({
      width: 1280,
      height: 800,
      deviceScaleFactor: 2,
    });
    expect(parseViewport("1280x800@1.5x")).toEqual({
      width: 1280,
      height: 800,
      deviceScaleFactor: 1.5,
    });
    expect(parseViewport("1280x800@3")).toEqual({ width: 1280, height: 800, deviceScaleFactor: 3 });
  });

  it("rejects malformed input", () => {
    expect(() => parseViewport("garbage")).toThrow(UploadsError);
    expect(() => parseViewport("0x0")).toThrow(UploadsError);
    expect(() => parseViewport("1280x")).toThrow(UploadsError);
  });
});

describe("parseWaitUntil", () => {
  it("defaults to load", () => {
    expect(parseWaitUntil(undefined)).toBe("load");
  });
  it("accepts the known strategies", () => {
    expect(parseWaitUntil("networkidle")).toBe("networkidle");
    expect(parseWaitUntil("domcontentloaded")).toBe("domcontentloaded");
  });
  it("accepts a millisecond count", () => {
    expect(parseWaitUntil("500")).toBe(500);
  });
  it("rejects anything else", () => {
    expect(() => parseWaitUntil("whenever")).toThrow(UploadsError);
  });
});

describe("isPrivateOrLocalHost", () => {
  it("flags localhost/private ranges", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "192.168.1.5",
      "10.0.0.4",
      "172.16.0.1",
      "foo.local",
    ]) {
      expect(isPrivateOrLocalHost(host)).toBe(true);
    }
  });
  it("does not flag public hosts", () => {
    for (const host of ["example.com", "uploads.sh", "8.8.8.8"]) {
      expect(isPrivateOrLocalHost(host)).toBe(false);
    }
  });

  it("strips IPv6 brackets before testing, as new URL(...).hostname returns them", () => {
    expect(isPrivateOrLocalHost("[::1]")).toBe(true);
    expect(isPrivateOrLocalHost("::1")).toBe(true);
  });

  it("flags 169.254.0.0/16 link-local", () => {
    expect(isPrivateOrLocalHost("169.254.1.2")).toBe(true);
  });

  it("flags .internal and .localhost subdomains, not just bare localhost", () => {
    expect(isPrivateOrLocalHost("api.internal")).toBe(true);
    expect(isPrivateOrLocalHost("foo.localhost")).toBe(true);
    expect(isPrivateOrLocalHost("localhost")).toBe(true);
  });

  it("flags IPv6 ULA (fc00::/7) and link-local (fe80::/10)", () => {
    expect(isPrivateOrLocalHost("fc00::1")).toBe(true);
    expect(isPrivateOrLocalHost("fd12:3456::1")).toBe(true);
    expect(isPrivateOrLocalHost("fe80::1")).toBe(true);
    expect(isPrivateOrLocalHost("[fe80::1]")).toBe(true);
  });

  it("does not flag unrelated IPv6 addresses", () => {
    expect(isPrivateOrLocalHost("2001:4860:4860::8888")).toBe(false);
  });

  it("flags IPv4-mapped IPv6 addresses when the mapped quad is private", () => {
    expect(isPrivateOrLocalHost("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateOrLocalHost("::ffff:192.168.1.1")).toBe(true);
    // hex form: ::ffff:a00:1 -> 10.0.0.1
    expect(isPrivateOrLocalHost("::ffff:a00:1")).toBe(true);
  });

  it("does not flag an IPv4-mapped IPv6 address when the mapped quad is public", () => {
    expect(isPrivateOrLocalHost("::ffff:8.8.8.8")).toBe(false);
  });
});

describe("classifyTarget", () => {
  it("classifies a public http(s) URL as non-local-only", () => {
    const t = classifyTarget("https://example.com/path");
    expect(t).toEqual({ kind: "url", url: "https://example.com/path", localOnly: false });
  });

  it("classifies a localhost URL as local-only", () => {
    const t = classifyTarget("http://localhost:3000");
    expect(t.kind).toBe("url");
    if (t.kind === "url") expect(t.localOnly).toBe(true);
  });

  it("reads an existing .html file", () => {
    const dir = mkdtempSync(join(tmpdir(), "uploads-screenshot-"));
    const file = join(dir, "card.html");
    writeFileSync(file, "<html><body>hi</body></html>");
    const t = classifyTarget(file);
    expect(t.kind).toBe("html-file");
    if (t.kind === "html-file") expect(t.html).toContain("hi");
  });

  it("throws USAGE for a missing target", () => {
    expect(() => classifyTarget("./definitely-missing.html")).toThrow(UploadsError);
  });
});

describe("captureScreenshot backend selection", () => {
  const png = new Uint8Array([9, 9, 9]);

  it("uses local when --via local is requested", async () => {
    let usedLocal = false;
    const result = await captureScreenshot({
      target: "https://example.com",
      via: "local",
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureLocalImpl: async () => {
        usedLocal = true;
        return png;
      },
    });
    expect(usedLocal).toBe(true);
    expect(result.backend).toBe("local");
    expect(result.png).toEqual(png);
  });

  it("uses remote when --via remote is requested for a public URL", async () => {
    let usedRemote = false;
    const result = await captureScreenshot({
      target: "https://example.com",
      via: "remote",
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureRemoteImpl: async () => {
        usedRemote = true;
        return png;
      },
    });
    expect(usedRemote).toBe(true);
    expect(result.backend).toBe("remote");
  });

  it("--via remote on a localhost target fails fast instead of sending a doomed request", async () => {
    let usedRemote = false;
    await expect(
      captureScreenshot({
        target: "http://localhost:4000",
        via: "remote",
        apiUrl: "https://api.uploads.sh",
        token: "t",
        captureRemoteImpl: async () => {
          usedRemote = true;
          return png;
        },
      }),
    ).rejects.toThrow(UploadsError);
    expect(usedRemote).toBe(false);
  });

  it("--via remote on an .html file target fails fast", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uploads-screenshot-"));
    const file = join(dir, "card.html");
    writeFileSync(file, "<html></html>");
    await expect(
      captureScreenshot({
        target: file,
        via: "remote",
        apiUrl: "https://api.uploads.sh",
        token: "t",
      }),
    ).rejects.toThrow(UploadsError);
  });

  it("auto falls back to remote when no local browser is detected", async () => {
    let usedRemote = false;
    const result = await captureScreenshot({
      target: "https://example.com",
      via: "auto",
      apiUrl: "https://api.uploads.sh",
      token: "t",
      // Force detectLocalBrowser to find nothing, regardless of what's
      // actually installed on the machine running this test.
      detectRoots: {
        env: {},
        systemCandidates: [],
        playwrightCacheDir: "/nonexistent/ms-playwright",
        puppeteerCacheDir: "/nonexistent/puppeteer",
      },
      captureRemoteImpl: async () => {
        usedRemote = true;
        return png;
      },
    });
    expect(usedRemote).toBe(true);
    expect(result.backend).toBe("remote");
  });

  it("auto uses local when a local browser is detected", async () => {
    let usedLocal = false;
    let seenDetectResult: unknown;
    const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const result = await captureScreenshot({
      target: "https://example.com",
      via: "auto",
      apiUrl: "https://api.uploads.sh",
      token: "t",
      detectRoots: {
        env: {},
        systemCandidates: [{ kind: "chrome", path: systemChrome }],
        exists: (p: string) => p === systemChrome,
        playwrightCacheDir: "/nonexistent/ms-playwright",
        puppeteerCacheDir: "/nonexistent/puppeteer",
      },
      captureLocalImpl: async (opts) => {
        usedLocal = true;
        seenDetectResult = opts.detectResult;
        return png;
      },
    });
    expect(usedLocal).toBe(true);
    expect(result.backend).toBe("local");
    // auto-routing's probe result is threaded through so the local capture
    // doesn't have to re-scan the filesystem a second time.
    expect(seenDetectResult).toMatchObject({ winner: { executablePath: systemChrome } });
  });

  it("--via local (no auto-probe) does not pre-populate detectResult — capture scans once itself", async () => {
    let seenDetectResult: unknown = "unset";
    await captureScreenshot({
      target: "https://example.com",
      via: "local",
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureLocalImpl: async (opts) => {
        seenDetectResult = opts.detectResult;
        return png;
      },
    });
    expect(seenDetectResult).toBeUndefined();
  });

  it("rejects a numeric --wait on --via remote before making any request", async () => {
    let usedRemote = false;
    await expect(
      captureScreenshot({
        target: "https://example.com",
        via: "remote",
        waitUntil: 500,
        apiUrl: "https://api.uploads.sh",
        token: "t",
        captureRemoteImpl: async () => {
          usedRemote = true;
          return png;
        },
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
    expect(usedRemote).toBe(false);
  });

  it("rejects a numeric --wait when auto resolves to remote (no local browser)", async () => {
    let usedRemote = false;
    await expect(
      captureScreenshot({
        target: "https://example.com",
        via: "auto",
        waitUntil: 250,
        apiUrl: "https://api.uploads.sh",
        token: "t",
        detectRoots: {
          env: {},
          systemCandidates: [],
          playwrightCacheDir: "/nonexistent/ms-playwright",
          puppeteerCacheDir: "/nonexistent/puppeteer",
        },
        captureRemoteImpl: async () => {
          usedRemote = true;
          return png;
        },
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
    expect(usedRemote).toBe(false);
  });

  it("allows a numeric --wait on --via local", async () => {
    let seenWait: unknown;
    const result = await captureScreenshot({
      target: "https://example.com",
      via: "local",
      waitUntil: 500,
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureLocalImpl: async (opts) => {
        seenWait = opts.waitUntil;
        return png;
      },
    });
    expect(seenWait).toBe(500);
    expect(result.backend).toBe("local");
  });

  it("auto on a localhost target errors clearly when no local browser is found (no doomed remote request)", async () => {
    let usedRemote = false;
    await expect(
      captureScreenshot({
        target: "http://localhost:4000",
        via: "auto",
        apiUrl: "https://api.uploads.sh",
        token: "t",
        detectRoots: {
          env: {},
          systemCandidates: [],
          playwrightCacheDir: "/nonexistent/ms-playwright",
          puppeteerCacheDir: "/nonexistent/puppeteer",
        },
        captureRemoteImpl: async () => {
          usedRemote = true;
          return png;
        },
      }),
    ).rejects.toMatchObject({ code: "BROWSER_NOT_FOUND" });
    expect(usedRemote).toBe(false);
  });
});
