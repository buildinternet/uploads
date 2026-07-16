/**
 * Local screenshot backend — drives an already-installed Chrome/Chromium via
 * `playwright-core` (no browser download; ~12 MB of JS).
 *
 * IMPORTANT: `playwright-core` must never be statically imported. This module
 * is Node-only and is itself only ever reached via dynamic `await import()`
 * from callers (never from index.ts / agent.ts / mcp/server.ts) so the
 * apps/mcp Cloudflare Worker — which bundles those three entry points — never
 * pulls this file (or playwright-core) into its bundle.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UploadsError } from "./errors.js";

export type BrowserCandidateSource = "env" | "system" | "playwright-cache" | "puppeteer-cache";

export interface BrowserCandidate {
  source: BrowserCandidateSource;
  /** e.g. "chrome", "chromium", "chromium_headless_shell", "edge". */
  kind: string;
  executablePath: string;
  /** Cache revision/build string, when applicable. */
  revision?: string;
}

export interface DetectRoots {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  playwrightCacheDir?: string;
  puppeteerCacheDir?: string;
  /** Injectable for tests: overrides the fixed system-install paths. */
  systemCandidates?: readonly { kind: string; path: string }[];
  /** Injectable for tests: replaces fs.existsSync. */
  exists?: (path: string) => boolean;
  /** Injectable for tests: replaces fs.readdirSync. */
  readdir?: (path: string) => string[];
}

export interface DetectResult {
  /** Explicit --browser / UPLOADS_CHROME_PATH / CHROME_PATH override, if any. */
  envOverride?: string;
  candidates: BrowserCandidate[];
  /** Best candidate by the documented ranking, or undefined if none found. */
  winner?: BrowserCandidate;
}

function defaultPlaywrightCacheDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (env.PLAYWRIGHT_BROWSERS_PATH) return env.PLAYWRIGHT_BROWSERS_PATH;
  if (platform === "darwin") return join(homedir(), "Library", "Caches", "ms-playwright");
  if (platform === "win32") return join(homedir(), "AppData", "Local", "ms-playwright");
  return join(homedir(), ".cache", "ms-playwright");
}

function defaultPuppeteerCacheDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (env.PUPPETEER_CACHE_DIR) return env.PUPPETEER_CACHE_DIR;
  if (platform === "win32") return join(homedir(), "AppData", "Local", "puppeteer", "cache");
  return join(homedir(), ".cache", "puppeteer");
}

function defaultSystemCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { kind: string; path: string }[] {
  if (platform === "darwin") {
    return [
      { kind: "chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
      { kind: "edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
      { kind: "chromium", path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
      { kind: "brave", path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
    ];
  }
  if (platform === "linux") {
    return [
      { kind: "chrome", path: "/usr/bin/google-chrome" },
      { kind: "chrome", path: "/usr/bin/google-chrome-stable" },
      { kind: "chromium", path: "/usr/bin/chromium-browser" },
      { kind: "chromium", path: "/usr/bin/chromium" },
      { kind: "edge", path: "/usr/bin/microsoft-edge" },
    ];
  }
  if (platform === "win32") {
    const pf = env.PROGRAMFILES ?? "C:\\Program Files";
    const pf86 = env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    return [
      { kind: "chrome", path: join(pf, "Google", "Chrome", "Application", "chrome.exe") },
      { kind: "chrome", path: join(pf86, "Google", "Chrome", "Application", "chrome.exe") },
      { kind: "edge", path: join(pf, "Microsoft", "Edge", "Application", "msedge.exe") },
      { kind: "edge", path: join(pf86, "Microsoft", "Edge", "Application", "msedge.exe") },
    ];
  }
  return [];
}

/** Executable subpath inside a Playwright chromium/chromium_headless_shell revision dir. */
function playwrightExecutable(
  revisionDir: string,
  kind: "chromium" | "chromium_headless_shell",
  platform: NodeJS.Platform,
  exists: (p: string) => boolean,
): string | undefined {
  const layouts: string[] =
    kind === "chromium"
      ? platform === "darwin"
        ? [
            join(
              revisionDir,
              "chrome-mac-arm64",
              "Google Chrome for Testing.app",
              "Contents",
              "MacOS",
              "Google Chrome for Testing",
            ),
            join(revisionDir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
          ]
        : platform === "linux"
          ? [join(revisionDir, "chrome-linux", "chrome")]
          : platform === "win32"
            ? [join(revisionDir, "chrome-win", "chrome.exe")]
            : []
      : platform === "darwin"
        ? [join(revisionDir, "chrome-headless-shell-mac-arm64", "chrome-headless-shell")]
        : platform === "linux"
          ? [join(revisionDir, "chrome-headless-shell-linux", "chrome-headless-shell")]
          : platform === "win32"
            ? [join(revisionDir, "chrome-headless-shell-win", "chrome-headless-shell.exe")]
            : [];
  return layouts.find((p) => exists(p));
}

function scanPlaywrightCache(
  dir: string,
  platform: NodeJS.Platform,
  exists: (p: string) => boolean,
  readdir: (p: string) => string[],
): BrowserCandidate[] {
  if (!exists(dir)) return [];
  let entries: string[];
  try {
    entries = readdir(dir);
  } catch {
    return [];
  }
  const out: BrowserCandidate[] = [];
  for (const kind of ["chromium", "chromium_headless_shell"] as const) {
    const matches = entries
      .filter((e) => e.startsWith(`${kind}-`))
      .map((e) => ({ name: e, rev: Number.parseInt(e.slice(kind.length + 1), 10) || 0 }))
      .toSorted((a, b) => b.rev - a.rev); // newest revision first
    for (const m of matches) {
      const exe = playwrightExecutable(join(dir, m.name), kind, platform, exists);
      if (exe)
        out.push({
          source: "playwright-cache",
          kind,
          executablePath: exe,
          revision: String(m.rev),
        });
    }
  }
  return out;
}

function puppeteerExecutable(
  buildDir: string,
  kind: "chrome" | "chrome-headless-shell",
  platform: NodeJS.Platform,
  exists: (p: string) => boolean,
): string | undefined {
  let sub: string;
  if (platform === "darwin")
    sub = kind === "chrome" ? "chrome-mac-arm64" : "chrome-headless-shell-mac-arm64";
  else if (platform === "win32")
    sub = kind === "chrome" ? "chrome-win64" : "chrome-headless-shell-win64";
  else sub = kind === "chrome" ? "chrome-linux64" : "chrome-headless-shell-linux64";

  let exe: string;
  if (kind === "chrome") {
    exe =
      platform === "darwin"
        ? join(
            buildDir,
            sub,
            "Google Chrome for Testing.app",
            "Contents",
            "MacOS",
            "Google Chrome for Testing",
          )
        : platform === "win32"
          ? join(buildDir, sub, "chrome.exe")
          : join(buildDir, sub, "chrome");
  } else {
    exe = join(
      buildDir,
      sub,
      platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell",
    );
  }
  return exists(exe) ? exe : undefined;
}

function scanPuppeteerCache(
  dir: string,
  platform: NodeJS.Platform,
  exists: (p: string) => boolean,
  readdir: (p: string) => string[],
): BrowserCandidate[] {
  const out: BrowserCandidate[] = [];
  for (const kind of ["chrome", "chrome-headless-shell"] as const) {
    const kindDir = join(dir, kind);
    if (!exists(kindDir)) continue;
    let builds: string[];
    try {
      builds = readdir(kindDir);
    } catch {
      continue;
    }
    builds = builds
      .filter((b) => exists(join(kindDir, b)))
      .sort((a, b) => {
        const va = (a.match(/[\d.]+$/) ?? ["0"])[0]!;
        const vb = (b.match(/[\d.]+$/) ?? ["0"])[0]!;
        return vb.localeCompare(va, undefined, { numeric: true });
      });
    for (const b of builds) {
      const exe = puppeteerExecutable(join(kindDir, b), kind, platform, exists);
      if (exe) out.push({ source: "puppeteer-cache", kind, executablePath: exe, revision: b });
    }
  }
  return out;
}

/**
 * Scan for a usable local Chromium-family executable. Pure fs/env — never
 * launches a browser. Roots are injectable so tests can fake a cache layout.
 */
export function detectLocalBrowser(roots: DetectRoots = {}): DetectResult {
  const platform = roots.platform ?? process.platform;
  const env = roots.env ?? process.env;
  const exists = roots.exists ?? existsSync;
  const readdir = roots.readdir ?? ((p: string) => readdirSync(p) as string[]);

  const envOverride = env.UPLOADS_CHROME_PATH || env.CHROME_PATH || undefined;
  const candidates: BrowserCandidate[] = [];
  if (envOverride && exists(envOverride)) {
    candidates.push({ source: "env", kind: "env-override", executablePath: envOverride });
  }

  const systemCandidates = roots.systemCandidates ?? defaultSystemCandidates(platform, env);
  for (const c of systemCandidates) {
    if (exists(c.path)) candidates.push({ source: "system", kind: c.kind, executablePath: c.path });
  }

  candidates.push(
    ...scanPlaywrightCache(
      roots.playwrightCacheDir ?? defaultPlaywrightCacheDir(env, platform),
      platform,
      exists,
      readdir,
    ),
  );
  candidates.push(
    ...scanPuppeteerCache(
      roots.puppeteerCacheDir ?? defaultPuppeteerCacheDir(env, platform),
      platform,
      exists,
      readdir,
    ),
  );

  // Ranking: env override > system Chrome (channel:'chrome' launch target,
  // preferred default) > playwright cache chromium > puppeteer cache chrome >
  // any other system browser > headless-shell builds last (see brief).
  const rank = (c: BrowserCandidate): number => {
    if (c.source === "env") return 0;
    if (c.source === "system" && c.kind === "chrome") return 1;
    if (c.source === "playwright-cache" && c.kind === "chromium") return 2;
    if (c.source === "puppeteer-cache" && c.kind === "chrome") return 3;
    if (c.source === "system") return 4;
    if (c.source === "playwright-cache" && c.kind === "chromium_headless_shell") return 5;
    if (c.source === "puppeteer-cache" && c.kind === "chrome-headless-shell") return 6;
    return 9;
  };
  const winner = [...candidates].toSorted((a, b) => rank(a) - rank(b))[0];
  return { envOverride, candidates, winner };
}

export interface LocalCaptureOptions {
  /** URL to navigate to, or a `file://` URL for local .html targets. */
  url: string;
  /** Explicit browser executable (--browser / UPLOADS_CHROME_PATH / CHROME_PATH). */
  browserPath?: string;
  /** Attach to a running Chrome instead of launching one. */
  cdp?: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  selector?: string;
  fullPage?: boolean;
  colorScheme?: "dark" | "light";
  /** "load" | "domcontentloaded" | "networkidle", or a millisecond settle delay. */
  waitUntil: "load" | "domcontentloaded" | "networkidle" | number;
  timeoutMs?: number;
  detectRoots?: DetectRoots;
  /**
   * Pre-computed detection result from a caller that already scanned the
   * filesystem (e.g. `auto`-routing's probe) — avoids re-running
   * `detectLocalBrowser` a second time for the same capture.
   */
  detectResult?: DetectResult;
}

type PlaywrightCoreModule = typeof import("playwright-core");

async function loadPlaywrightCore(): Promise<PlaywrightCoreModule> {
  try {
    // Dynamic import only — never hoist this to a static `import` statement.
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    return (await import("playwright-core")) as PlaywrightCoreModule;
  } catch (err) {
    throw new UploadsError(
      `no local browser runtime available (playwright-core failed to load: ${
        err instanceof Error ? err.message : String(err)
      })`,
      "BROWSER_NOT_FOUND",
    );
  }
}

/** Launch a browser per the documented detection order. Never throws BROWSER_NOT_FOUND for a bad candidate — falls through to the next. */
async function launchLocalBrowser(
  chromium: PlaywrightCoreModule["chromium"],
  opts: LocalCaptureOptions,
): Promise<import("playwright-core").Browser> {
  if (opts.browserPath) {
    return chromium.launch({ executablePath: opts.browserPath, headless: true });
  }

  const detected = opts.detectResult ?? detectLocalBrowser(opts.detectRoots);
  if (detected.envOverride) {
    try {
      return await chromium.launch({ executablePath: detected.envOverride, headless: true });
    } catch {
      // fall through
    }
  }

  // Preferred default: let playwright-core resolve system Chrome itself.
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    // fall through
  }
  try {
    return await chromium.launch({ channel: "msedge", headless: true });
  } catch {
    // fall through
  }

  for (const candidate of detected.candidates) {
    if (candidate.source === "env") continue; // already tried above
    try {
      return await chromium.launch({ executablePath: candidate.executablePath, headless: true });
    } catch {
      // try the next candidate
    }
  }

  throw new UploadsError(
    "no local browser found — install Chrome, or run `npx playwright install chromium`",
    "BROWSER_NOT_FOUND",
  );
}

/** Capture a PNG screenshot using a local (already-installed) browser. */
export async function captureLocal(opts: LocalCaptureOptions): Promise<Uint8Array> {
  const { chromium } = await loadPlaywrightCore();

  let browser: import("playwright-core").Browser;
  let usingCdp = false;
  if (opts.cdp) {
    try {
      browser = await chromium.connectOverCDP(opts.cdp);
      usingCdp = true;
    } catch (err) {
      throw new UploadsError(
        `could not connect to CDP endpoint ${opts.cdp}: ${err instanceof Error ? err.message : String(err)}`,
        "BROWSER_NOT_FOUND",
      );
    }
  } else {
    try {
      browser = await launchLocalBrowser(chromium, opts);
    } catch (err) {
      if (err instanceof UploadsError) throw err;
      throw new UploadsError(
        `could not launch a local browser: ${err instanceof Error ? err.message : String(err)}`,
        "BROWSER_NOT_FOUND",
      );
    }
  }

  try {
    // deviceScaleFactor cannot be set on an existing CDP context — the Chrome
    // process itself must have been launched with --force-device-scale-factor.
    const context = usingCdp
      ? (browser.contexts()[0] ?? (await browser.newContext()))
      : await browser.newContext({
          viewport: { width: opts.viewport.width, height: opts.viewport.height },
          deviceScaleFactor: opts.viewport.deviceScaleFactor,
          colorScheme: opts.colorScheme,
        });
    const page = usingCdp
      ? await context.newPage()
      : (context.pages()[0] ?? (await context.newPage()));
    if (usingCdp) {
      await page.setViewportSize({ width: opts.viewport.width, height: opts.viewport.height });
      if (opts.colorScheme) await page.emulateMedia({ colorScheme: opts.colorScheme });
    }

    const waitUntil = typeof opts.waitUntil === "string" ? opts.waitUntil : "load";
    await page.goto(opts.url, { waitUntil, timeout: opts.timeoutMs ?? 30_000 });
    if (typeof opts.waitUntil === "number") await page.waitForTimeout(opts.waitUntil);

    const png = opts.selector
      ? await page.locator(opts.selector).screenshot({ timeout: opts.timeoutMs ?? 30_000 })
      : await page.screenshot({ fullPage: opts.fullPage === true });
    // Buffer extends Uint8Array — return it as-is rather than copying.
    return png;
  } finally {
    await browser.close();
  }
}
