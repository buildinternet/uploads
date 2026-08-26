import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UploadsError } from "../src/errors.js";
import { isLoopbackHost } from "../src/private-host.js";
import {
  captureScreenshot,
  classifyTarget,
  DEFAULT_FULL_PAGE_MAX_HEIGHT,
  DEV_TOOLBAR_SELECTORS,
  foldStateIntoFilename,
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

describe("isLoopbackHost", () => {
  it.each(["localhost", "app.localhost", "127.0.0.1", "127.0.0.8", "::1", "[::1]"])(
    "flags %s",
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each([
    "10.0.0.4",
    "192.168.1.5",
    "169.254.169.254",
    "foo.internal",
    "foo.local",
    "example.com",
    "8.8.8.8",
    "0.0.0.0",
  ])("does not flag %s", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });

  it("flags IPv4-mapped loopback only", () => {
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::ffff:7f00:1")).toBe(true);
    expect(isLoopbackHost("::ffff:10.0.0.1")).toBe(false);
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

describe("foldStateIntoFilename", () => {
  it("inserts -<state> before the extension", () => {
    expect(foldStateIntoFilename("localhost-docs-mcp.png", "before")).toBe(
      "localhost-docs-mcp-before.png",
    );
    expect(foldStateIntoFilename("localhost-docs-mcp.png", "after")).toBe(
      "localhost-docs-mcp-after.png",
    );
  });

  it("is a no-op when no state is given", () => {
    expect(foldStateIntoFilename("localhost-docs-mcp.png", undefined)).toBe(
      "localhost-docs-mcp.png",
    );
  });

  it("does not double-append when the stem already ends with -<state>", () => {
    expect(foldStateIntoFilename("localhost-docs-mcp-before.png", "before")).toBe(
      "localhost-docs-mcp-before.png",
    );
  });

  it("handles a filename with no extension", () => {
    expect(foldStateIntoFilename("screenshot", "before")).toBe("screenshot-before");
  });

  it("folds only canonical state values — free-form metadata state stays out of the key", () => {
    // A free-form `--meta state=…` passes validateMetaMap (any printable
    // ASCII, including `/` and spaces) and reaches the fold via the merged
    // metadata bag; it must never enter the derived object name.
    expect(foldStateIntoFilename("localhost-docs-mcp.png", "x/y")).toBe("localhost-docs-mcp.png");
    expect(foldStateIntoFilename("localhost-docs-mcp.png", "two words")).toBe(
      "localhost-docs-mcp.png",
    );
    expect(foldStateIntoFilename("localhost-docs-mcp.png", "Before")).toBe(
      "localhost-docs-mcp.png",
    );
  });
});

describe("captureScreenshot backend selection", () => {
  const png = new Uint8Array([9, 9, 9]);

  it("folds --state into the derived filename, so before/after produce distinct keys", async () => {
    const before = await captureScreenshot({
      target: "https://example.com/docs/mcp",
      via: "remote",
      state: "before",
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureRemoteImpl: async () => ({ png, clipped: false }),
    });
    const after = await captureScreenshot({
      target: "https://example.com/docs/mcp",
      via: "remote",
      state: "after",
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureRemoteImpl: async () => ({ png, clipped: false }),
    });
    expect(before.filename).toBe("example.com-docs-mcp-before.png");
    expect(after.filename).toBe("example.com-docs-mcp-after.png");
    expect(before.filename).not.toBe(after.filename);
  });

  it("leaves the derived filename untouched when no state is given", async () => {
    const result = await captureScreenshot({
      target: "https://example.com/docs/mcp",
      via: "remote",
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureRemoteImpl: async () => ({ png, clipped: false }),
    });
    expect(result.filename).toBe("example.com-docs-mcp.png");
  });

  it("uses local when --via local is requested", async () => {
    let usedLocal = false;
    const result = await captureScreenshot({
      target: "https://example.com",
      via: "local",
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureLocalImpl: async () => {
        usedLocal = true;
        return { png };
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
        return { png, clipped: false };
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
          return { png, clipped: false };
        },
      }),
    ).rejects.toThrow(UploadsError);
    expect(usedRemote).toBe(false);
  });

  it("--via remote on an .html file POSTs its contents as inline html", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uploads-screenshot-"));
    const file = join(dir, "card.html");
    writeFileSync(file, "<html><body>hi</body></html>");
    let sentHtml: string | undefined;
    const result = await captureScreenshot({
      target: file,
      via: "remote",
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureRemoteImpl: async (body) => {
        sentHtml = (body as { html?: string }).html;
        return { png, clipped: false };
      },
    });
    expect(sentHtml).toBe("<html><body>hi</body></html>");
    expect(result.backend).toBe("remote");
  });

  it("--via remote rejects an .html file over the 2 MiB inline limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uploads-screenshot-"));
    const file = join(dir, "big.html");
    writeFileSync(file, `<html>${"x".repeat(2 * 1024 * 1024)}</html>`);
    let usedRemote = false;
    await expect(
      captureScreenshot({
        target: file,
        via: "remote",
        apiUrl: "https://api.uploads.sh",
        token: "t",
        captureRemoteImpl: async () => {
          usedRemote = true;
          return { png, clipped: false };
        },
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
    expect(usedRemote).toBe(false);
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
        return { png, clipped: false };
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
        return { png };
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
        return { png };
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
          return { png, clipped: false };
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
          return { png, clipped: false };
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
        return { png };
      },
    });
    expect(seenWait).toBe(500);
    expect(result.backend).toBe("local");
  });

  it("auto-hides dev toolbars on a localhost target, passing them to the local backend", async () => {
    let seenHide: string[] | undefined;
    await captureScreenshot({
      target: "http://localhost:3000",
      via: "local",
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureLocalImpl: async (opts) => {
        seenHide = opts.hide;
        return { png };
      },
    });
    expect(seenHide).toEqual([...DEV_TOOLBAR_SELECTORS]);
  });

  it("does not auto-hide dev toolbars on a public target", async () => {
    let seenHide: string[] | undefined;
    await captureScreenshot({
      target: "https://example.com",
      via: "local",
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureLocalImpl: async (opts) => {
        seenHide = opts.hide;
        return { png };
      },
    });
    expect(seenHide).toEqual([]);
  });

  it("--no-hide-dev-tools (hideDevTools:false) suppresses auto-hide but keeps explicit --hide", async () => {
    let seenHide: string[] | undefined;
    await captureScreenshot({
      target: "http://localhost:3000",
      via: "local",
      hide: [".banner"],
      hideDevTools: false,
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureLocalImpl: async (opts) => {
        seenHide = opts.hide;
        return { png };
      },
    });
    expect(seenHide).toEqual([".banner"]);
  });

  it("combines explicit --hide with auto-hidden dev toolbars", async () => {
    let seenHide: string[] | undefined;
    await captureScreenshot({
      target: "http://localhost:3000",
      via: "local",
      hide: [".banner"],
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureLocalImpl: async (opts) => {
        seenHide = opts.hide;
        return { png };
      },
    });
    expect(seenHide).toEqual([".banner", ...DEV_TOOLBAR_SELECTORS]);
  });

  it("rejects a --hide selector that could break out of the injected rule", async () => {
    await expect(
      captureScreenshot({
        target: "https://example.com",
        via: "local",
        hide: ["ok", "evil}{body{display:none"],
        apiUrl: "https://api.uploads.sh",
        token: "t",
        captureLocalImpl: async () => ({ png }),
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("rejects a --hide at-rule that would smuggle an @import (no braces needed)", async () => {
    await expect(
      captureScreenshot({
        target: "https://example.com",
        via: "local",
        hide: ["@import url(http://127.0.0.1);*"],
        apiUrl: "https://api.uploads.sh",
        token: "t",
        captureLocalImpl: async () => ({ png }),
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("forwards reducedMotion and hide to the remote backend body", async () => {
    let sentBody: Record<string, unknown> | undefined;
    await captureScreenshot({
      target: "https://example.com",
      via: "remote",
      hide: [".banner"],
      reducedMotion: true,
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureRemoteImpl: async (body) => {
        sentBody = body as unknown as Record<string, unknown>;
        return { png, clipped: false };
      },
    });
    expect(sentBody).toMatchObject({ hide: [".banner"], reducedMotion: true });
  });

  it("rejects --eval on the remote backend (local-only) before any request", async () => {
    let usedRemote = false;
    await expect(
      captureScreenshot({
        target: "https://example.com",
        via: "remote",
        evalJs: "document.title = 'x'",
        apiUrl: "https://api.uploads.sh",
        token: "t",
        captureRemoteImpl: async () => {
          usedRemote = true;
          return { png, clipped: false };
        },
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
    expect(usedRemote).toBe(false);
  });

  it("forwards --wait-for to the local backend", async () => {
    let seenWaitFor: unknown;
    await captureScreenshot({
      target: "https://example.com",
      via: "local",
      waitForExpr: "window.__hydrated === true",
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureLocalImpl: async (opts) => {
        seenWaitFor = opts.waitForExpr;
        return { png };
      },
    });
    expect(seenWaitFor).toBe("window.__hydrated === true");
  });

  it("rejects --wait-for on the remote backend (local-only) before any request", async () => {
    let usedRemote = false;
    await expect(
      captureScreenshot({
        target: "https://example.com",
        via: "remote",
        waitForExpr: "window.__hydrated === true",
        apiUrl: "https://api.uploads.sh",
        token: "t",
        captureRemoteImpl: async () => {
          usedRemote = true;
          return { png, clipped: false };
        },
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
    expect(usedRemote).toBe(false);
  });

  it("rejects --wait-for when auto resolves to remote (no local browser)", async () => {
    let usedRemote = false;
    await expect(
      captureScreenshot({
        target: "https://example.com",
        via: "auto",
        waitForExpr: "window.__hydrated === true",
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
          return { png, clipped: false };
        },
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
    expect(usedRemote).toBe(false);
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
          return { png, clipped: false };
        },
      }),
    ).rejects.toMatchObject({ code: "BROWSER_NOT_FOUND" });
    expect(usedRemote).toBe(false);
  });

  it("measureSelectors round-trips through captureLocalImpl into result.measures", async () => {
    let seenMeasureSelectors: string[] | undefined;
    const result = await captureScreenshot({
      target: "https://example.com",
      via: "local",
      measureSelectors: ["h1", ".hero"],
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureLocalImpl: async (opts) => {
        seenMeasureSelectors = opts.measureSelectors;
        return {
          png,
          measures: {
            h1: { x: 10, y: 20, w: 100, h: 40 },
            ".hero": { x: 0, y: 0, w: 1280, h: 200 },
          },
        };
      },
    });
    expect(seenMeasureSelectors).toEqual(["h1", ".hero"]);
    expect(result.measures).toEqual({
      h1: { x: 10, y: 20, w: 100, h: 40 },
      ".hero": { x: 0, y: 0, w: 1280, h: 200 },
    });
  });

  it("captureLocalImpl without measures leaves result.measures undefined", async () => {
    const result = await captureScreenshot({
      target: "https://example.com",
      via: "local",
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureLocalImpl: async () => ({ png }),
    });
    expect(result.png).toEqual(png);
    expect(result.measures).toBeUndefined();
  });

  it("rejects measureSelectors on an explicit --via remote before any request", async () => {
    let usedRemote = false;
    await expect(
      captureScreenshot({
        target: "https://example.com",
        via: "remote",
        measureSelectors: ["h1"],
        apiUrl: "https://api.uploads.sh",
        token: "t",
        captureRemoteImpl: async () => {
          usedRemote = true;
          return { png, clipped: false };
        },
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
    expect(usedRemote).toBe(false);
  });

  it("rejects measureSelectors when auto resolves to remote (no local browser)", async () => {
    let usedRemote = false;
    await expect(
      captureScreenshot({
        target: "https://example.com",
        via: "auto",
        measureSelectors: ["h1"],
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
          return { png, clipped: false };
        },
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
    expect(usedRemote).toBe(false);
  });
});

describe("captureScreenshot full-page height cap (issue #652)", () => {
  const png = new Uint8Array([9, 9, 9]);

  it("applies the default cap to the local backend when --full-page is set and --max-height is omitted", async () => {
    let seenMaxHeightPx: number | undefined;
    await captureScreenshot({
      target: "https://example.com",
      via: "local",
      fullPage: true,
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureLocalImpl: async (opts) => {
        seenMaxHeightPx = opts.maxHeightPx;
        return { png, clipped: false };
      },
    });
    expect(seenMaxHeightPx).toBe(DEFAULT_FULL_PAGE_MAX_HEIGHT);
  });

  it("does not pass a cap when --full-page is not set", async () => {
    let seenMaxHeightPx: number | undefined;
    const result = await captureScreenshot({
      target: "https://example.com",
      via: "local",
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureLocalImpl: async (opts) => {
        seenMaxHeightPx = opts.maxHeightPx;
        return { png, clipped: false };
      },
    });
    expect(seenMaxHeightPx).toBe(0);
    expect(result.capped).toBeUndefined();
  });

  it("--max-height overrides the default on the local backend", async () => {
    let seenMaxHeightPx: number | undefined;
    const result = await captureScreenshot({
      target: "https://example.com",
      via: "local",
      fullPage: true,
      maxHeight: 8000,
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureLocalImpl: async (opts) => {
        seenMaxHeightPx = opts.maxHeightPx;
        return { png, clipped: false };
      },
    });
    expect(seenMaxHeightPx).toBe(8000);
    expect(result.capped).toEqual({ maxHeightPx: 8000, clipped: false });
  });

  it("--max-height 0 is uncapped: no cap forwarded, no capped result", async () => {
    let seenMaxHeightPx: number | undefined;
    const result = await captureScreenshot({
      target: "https://example.com",
      via: "local",
      fullPage: true,
      maxHeight: 0,
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureLocalImpl: async (opts) => {
        seenMaxHeightPx = opts.maxHeightPx;
        return { png, clipped: false };
      },
    });
    expect(seenMaxHeightPx).toBe(0);
    expect(result.capped).toBeUndefined();
  });

  it("propagates clipped: true from the local backend", async () => {
    const result = await captureScreenshot({
      target: "https://example.com",
      via: "local",
      fullPage: true,
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureLocalImpl: async () => ({ png, clipped: true }),
    });
    expect(result.capped).toEqual({ maxHeightPx: DEFAULT_FULL_PAGE_MAX_HEIGHT, clipped: true });
  });

  it("applies the default cap to the remote backend and propagates clipped: true", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const result = await captureScreenshot({
      target: "https://example.com",
      via: "remote",
      fullPage: true,
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureRemoteImpl: async (body) => {
        seenBody = body as unknown as Record<string, unknown>;
        return { png, clipped: true };
      },
    });
    expect(seenBody).toMatchObject({ fullPage: true, maxHeight: DEFAULT_FULL_PAGE_MAX_HEIGHT });
    expect(result.capped).toEqual({
      maxHeightPx: DEFAULT_FULL_PAGE_MAX_HEIGHT,
      clipped: true,
    });
  });

  it("does not send maxHeight to the remote backend when uncapped", async () => {
    let seenBody: Record<string, unknown> | undefined;
    await captureScreenshot({
      target: "https://example.com",
      via: "remote",
      fullPage: true,
      maxHeight: 0,
      apiUrl: "https://api.uploads.sh",
      token: "t",
      captureRemoteImpl: async (body) => {
        seenBody = body as unknown as Record<string, unknown>;
        return { png, clipped: false };
      },
    });
    expect(seenBody).not.toHaveProperty("maxHeight");
  });
});
