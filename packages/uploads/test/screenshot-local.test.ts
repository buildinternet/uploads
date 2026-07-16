import { describe, expect, it } from "vitest";
import { detectLocalBrowser, type DetectRoots } from "../src/screenshot-local.js";

/** Builds a fake fs (exists + readdir) over an in-memory tree of paths. */
function fakeFs(paths: readonly string[]) {
  const set = new Set(paths);
  // A path "exists" if it's a leaf file we listed, or a directory that
  // contains one of those leaves (mirrors real fs semantics well enough for
  // the detection scan, which only calls existsSync on dirs and leaf files).
  const exists = (p: string) => set.has(p) || [...set].some((f) => f.startsWith(`${p}/`));
  const readdir = (dir: string): string[] => {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    const names = new Set<string>();
    for (const p of set) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const first = rest.split("/")[0];
      if (first) names.add(first);
    }
    return [...names];
  };
  return { exists, readdir };
}

describe("detectLocalBrowser", () => {
  it("finds nothing when no candidate paths exist", () => {
    const { exists, readdir } = fakeFs([]);
    const result = detectLocalBrowser({
      platform: "darwin",
      env: {},
      exists,
      readdir,
      systemCandidates: [],
      playwrightCacheDir: "/home/.cache/ms-playwright",
      puppeteerCacheDir: "/home/.cache/puppeteer",
    });
    expect(result.candidates).toEqual([]);
    expect(result.winner).toBeUndefined();
  });

  it("prefers an env override above every other candidate", () => {
    const roots: DetectRoots = {
      platform: "darwin",
      env: { UPLOADS_CHROME_PATH: "/opt/my-chrome" },
      systemCandidates: [{ kind: "chrome", path: "/Applications/Google Chrome.app/x" }],
      playwrightCacheDir: "/home/.cache/ms-playwright",
      puppeteerCacheDir: "/home/.cache/puppeteer",
      ...fakeFs(["/opt/my-chrome", "/Applications/Google Chrome.app/x"]),
    };
    const result = detectLocalBrowser(roots);
    expect(result.envOverride).toBe("/opt/my-chrome");
    expect(result.winner).toEqual({
      source: "env",
      kind: "env-override",
      executablePath: "/opt/my-chrome",
    });
  });

  it("falls back to CHROME_PATH when UPLOADS_CHROME_PATH is unset", () => {
    const roots: DetectRoots = {
      platform: "linux",
      env: { CHROME_PATH: "/usr/local/bin/chrome" },
      systemCandidates: [],
      playwrightCacheDir: "/home/.cache/ms-playwright",
      puppeteerCacheDir: "/home/.cache/puppeteer",
      ...fakeFs(["/usr/local/bin/chrome"]),
    };
    const result = detectLocalBrowser(roots);
    expect(result.winner?.executablePath).toBe("/usr/local/bin/chrome");
  });

  it("prefers system Chrome over playwright/puppeteer caches", () => {
    const cacheDir = "/home/.cache/ms-playwright";
    const puppeteerDir = "/home/.cache/puppeteer";
    const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const pwChromium = `${cacheDir}/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
    const roots: DetectRoots = {
      platform: "darwin",
      env: {},
      systemCandidates: [{ kind: "chrome", path: systemChrome }],
      playwrightCacheDir: cacheDir,
      puppeteerCacheDir: puppeteerDir,
      ...fakeFs([systemChrome, pwChromium]),
    };
    const result = detectLocalBrowser(roots);
    expect(result.winner?.source).toBe("system");
    expect(result.winner?.executablePath).toBe(systemChrome);
    expect(result.candidates.some((c) => c.executablePath === pwChromium)).toBe(true);
  });

  it("finds the newest-revision chromium in the modern chrome-mac-arm64 layout", () => {
    const cacheDir = "/home/.cache/ms-playwright";
    const older = `${cacheDir}/chromium-1100/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
    const newer = `${cacheDir}/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
    const roots: DetectRoots = {
      platform: "darwin",
      env: {},
      systemCandidates: [],
      playwrightCacheDir: cacheDir,
      puppeteerCacheDir: "/home/.cache/puppeteer",
      ...fakeFs([older, newer]),
    };
    const result = detectLocalBrowser(roots);
    expect(result.winner?.source).toBe("playwright-cache");
    expect(result.winner?.kind).toBe("chromium");
    expect(result.winner?.executablePath).toBe(newer);
    expect(result.winner?.revision).toBe("1200");
  });

  it("finds chromium in the legacy chrome-mac/Chromium.app layout", () => {
    const cacheDir = "/home/.cache/ms-playwright";
    const legacy = `${cacheDir}/chromium-900/chrome-mac/Chromium.app/Contents/MacOS/Chromium`;
    const roots: DetectRoots = {
      platform: "darwin",
      env: {},
      systemCandidates: [],
      playwrightCacheDir: cacheDir,
      puppeteerCacheDir: "/home/.cache/puppeteer",
      ...fakeFs([legacy]),
    };
    const result = detectLocalBrowser(roots);
    expect(result.winner?.executablePath).toBe(legacy);
  });

  it("falls back to the puppeteer cache when no playwright cache or system browser exists", () => {
    const puppeteerDir = "/home/.cache/puppeteer";
    const chromeBuild = `${puppeteerDir}/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
    const roots: DetectRoots = {
      platform: "darwin",
      env: {},
      systemCandidates: [],
      playwrightCacheDir: "/home/.cache/ms-playwright",
      puppeteerCacheDir: puppeteerDir,
      ...fakeFs([chromeBuild]),
    };
    const result = detectLocalBrowser(roots);
    expect(result.winner?.source).toBe("puppeteer-cache");
    expect(result.winner?.executablePath).toBe(chromeBuild);
  });

  it("ranks headless-shell builds last, behind every other kind", () => {
    const cacheDir = "/home/.cache/ms-playwright";
    const shell = `${cacheDir}/chromium_headless_shell-1200/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
    const puppeteerDir = "/home/.cache/puppeteer";
    const chromeBuild = `${puppeteerDir}/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
    const roots: DetectRoots = {
      platform: "darwin",
      env: {},
      systemCandidates: [],
      playwrightCacheDir: cacheDir,
      puppeteerCacheDir: puppeteerDir,
      ...fakeFs([shell, chromeBuild]),
    };
    const result = detectLocalBrowser(roots);
    expect(result.winner?.executablePath).toBe(chromeBuild);
    expect(result.candidates.some((c) => c.executablePath === shell)).toBe(true);
  });
});
