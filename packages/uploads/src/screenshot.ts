/**
 * Shared screenshot capture core: target classification and dispatch to the
 * local backend (playwright-core, dynamic import). Used by both the CLI
 * command and the MCP tool.
 *
 * Deliberately NOT re-exported from index.ts/agent.ts — this module is safe
 * to import statically (it never touches playwright-core itself), but
 * keeping it out of the public entry points keeps the Worker-bundle
 * constraint obvious and easy to audit with a grep.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { UploadsError } from "./errors.js";
import { sanitizeFilename } from "./comment-render.generated.js";
import { isMetaStateValue } from "./metadata-vocab.js";
import { isPrivateOrLocalHost } from "./private-host.js";
import type { DetectRoots } from "./screenshot-local.js";

export { isPrivateOrLocalHost };

/**
 * The error for a caller still asking for the removed server-side renderer.
 * `--via auto` / `--via local` stay accepted (both mean the local browser) so
 * existing scripts and agent instructions keep working.
 */
export function remoteBackendRemovedError(): UploadsError {
  return new UploadsError(
    "remote screenshot rendering was removed — captures run in a local Chrome/Chromium (install Chrome, or run `npx playwright install chromium`)",
    "USAGE",
  );
}
export type WaitUntil = "load" | "domcontentloaded" | "networkidle" | number;

/**
 * Host selectors for framework dev toolbars/overlays that otherwise pollute a
 * screenshot of a running dev server. Hidden (display:none) automatically when
 * the target is a localhost/private URL, unless `--no-hide-dev-tools`. Hiding
 * the custom-element host also hides its shadow-DOM contents, so a single
 * host-level rule is enough for the web-component toolbars.
 */
export const DEV_TOOLBAR_SELECTORS: readonly string[] = [
  "astro-dev-toolbar", // Astro
  "#__next-build-watcher", // Next.js (legacy build-activity indicator)
  "nextjs-portal", // Next.js dev overlay / indicators (App Router)
  "#nuxt-devtools-anchor", // Nuxt DevTools launcher
  "#nuxt-devtools-container",
  "vite-plugin-checker-error-overlay", // vite-plugin-checker overlay
  "vite-error-overlay", // Vite HMR error overlay
];

/**
 * Reject a `--hide`/`--redact` selector that could break out of the generated
 * `selector{display:none}` rule (or inject markup server-side). The selectors
 * are the caller's own, so this guards against footguns, not a trust boundary.
 * `@` is rejected too: a leading at-rule (e.g. `@import url(...);*`) needs no
 * braces to smuggle an `@import` into the injected stylesheet — and `@` is
 * never valid in a CSS selector anyway.
 */
export function assertHideSelector(selector: string, flag = "hide"): void {
  if (selector.length === 0 || /[@{}<>]/.test(selector)) {
    throw new UploadsError(
      `invalid ${flag} selector: ${JSON.stringify(selector)} (a CSS selector, no @, {, }, <, or >)`,
      "USAGE",
    );
  }
}

export interface ScreenshotViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export const DEFAULT_SCREENSHOT_VIEWPORT: ScreenshotViewport = {
  width: 1280,
  height: 800,
  deviceScaleFactor: 2,
};

/**
 * Default cap (CSS px) on `--full-page` capture height (issue #652). Picked
 * from the 4000-6000px range the issue proposed: generous enough to cover a
 * long single-viewport marketing/docs page without clipping, but well short
 * of the multi-thousand-entry-list case that motivated this (a 53-entry
 * changelog page, PR #651) — those still clip, with a note pointing at
 * `--max-height` to raise or remove the cap. `0` (via `--max-height 0`) means
 * uncapped, for the rare case the full strip is genuinely wanted.
 */
export const DEFAULT_FULL_PAGE_MAX_HEIGHT = 5000;

/** Parses `WIDTHxHEIGHT[@SCALEx]`, e.g. "1280x800", "1280x800@2x", "1280x800@2". */
export function parseViewport(raw: string | undefined): ScreenshotViewport {
  if (!raw) return DEFAULT_SCREENSHOT_VIEWPORT;
  const match = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?)x?)?$/.exec(raw.trim());
  if (!match) {
    throw new UploadsError(
      `invalid viewport: ${raw} (expected WIDTHxHEIGHT[@SCALEx], e.g. 1280x800@2x)`,
      "USAGE",
    );
  }
  const width = Number.parseInt(match[1]!, 10);
  const height = Number.parseInt(match[2]!, 10);
  const deviceScaleFactor = match[3] ? Number.parseFloat(match[3]) : 1;
  if (width <= 0 || height <= 0 || deviceScaleFactor <= 0) {
    throw new UploadsError(`invalid viewport: ${raw} (values must be positive)`, "USAGE");
  }
  return { width, height, deviceScaleFactor };
}

/** Parses `--wait`: "load" | "domcontentloaded" | "networkidle" | a millisecond count. */
export function parseWaitUntil(raw: string | undefined): WaitUntil {
  if (!raw) return "load";
  if (raw === "load" || raw === "domcontentloaded" || raw === "networkidle") return raw;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  throw new UploadsError(
    `invalid wait strategy: ${raw} (use load, domcontentloaded, networkidle, or a millisecond count)`,
    "USAGE",
  );
}

export type ScreenshotTarget =
  | { kind: "url"; url: string; localOnly: boolean }
  | { kind: "html-file"; path: string; html: string };

/** Classifies a CLI target: http(s) URL, or a path to a local .html file. */
export function classifyTarget(target: string): ScreenshotTarget {
  if (/^https?:\/\//i.test(target)) {
    let hostname: string;
    try {
      hostname = new URL(target).hostname;
    } catch {
      throw new UploadsError(`invalid target URL: ${target}`, "USAGE");
    }
    return { kind: "url", url: target, localOnly: isPrivateOrLocalHost(hostname) };
  }

  const abs = resolvePath(target);
  if (!existsSync(abs)) {
    throw new UploadsError(
      `target not found: ${target} (expected a URL or an .html file)`,
      "USAGE",
    );
  }
  if (!statSync(abs).isFile() || !/\.html?$/i.test(abs)) {
    throw new UploadsError(
      `target must be an http(s) URL or an .html file (got ${target})`,
      "USAGE",
    );
  }
  return { kind: "html-file", path: abs, html: readFileSync(abs, "utf8") };
}

export interface CaptureScreenshotOptions {
  target: string;
  browserPath?: string;
  cdp?: string;
  viewport?: ScreenshotViewport;
  selector?: string;
  fullPage?: boolean;
  /**
   * Cap (CSS px) on `--full-page` capture height. Only meaningful with
   * `fullPage: true`; ignored otherwise. `undefined` applies
   * `DEFAULT_FULL_PAGE_MAX_HEIGHT`; `0` means uncapped (issue #652).
   */
  maxHeight?: number;
  colorScheme?: "dark" | "light";
  waitUntil?: WaitUntil;
  /**
   * Folded into the auto-derived filename's stem (e.g. `-before`) so a
   * before/after pair of the same URL yields two distinct object names
   * instead of silently overwriting each other. Callers must omit this when
   * the caller also gave an explicit object key/name — folding only applies
   * to the auto-derived name.
   */
  state?: string;
  /** Extra CSS selectors to hide (display:none) before capture. */
  hide?: string[];
  /**
   * CSS selectors blacked out before capture. Each must match at least one
   * element, or the capture fails (see `applyRedactions`).
   */
  redact?: string[];
  /**
   * Auto-hide known framework dev toolbars. Defaults to on for localhost/
   * private-network targets and off otherwise; pass `false` to opt out.
   */
  hideDevTools?: boolean;
  /** Emulate prefers-reduced-motion: reduce so CSS/JS animations settle. */
  reducedMotion?: boolean;
  /**
   * JS expression polled in the page until truthy after settle, before
   * `evalJs` and capture — the caller's "app is interactive" signal so a
   * synthetic click in `evalJs` lands after framework hydration (issue #715).
   */
  waitForExpr?: string;
  /** Run this JS in the page after settle, before capture. */
  evalJs?: string;
  /** Inject this JS as an init script before navigation. */
  initScript?: string;
  /** Injectable for tests; forwarded to detectLocalBrowser. */
  detectRoots?: DetectRoots;
  /** Injectable for tests: replaces the local capture implementation. */
  captureLocalImpl?: (opts: {
    url: string;
    browserPath?: string;
    cdp?: string;
    viewport: ScreenshotViewport;
    selector?: string;
    fullPage?: boolean;
    /** CSS px cap on full-page height; 0 or undefined = uncapped. */
    maxHeightPx?: number;
    colorScheme?: "dark" | "light";
    waitUntil: WaitUntil;
    hide?: string[];
    redact?: string[];
    reducedMotion?: boolean;
    waitForExpr?: string;
    evalJs?: string;
    initScript?: string;
    detectRoots?: DetectRoots;
  }) => Promise<{
    png: Uint8Array;
    /** Present when `fullPage` + a positive `maxHeightPx` were given. */
    clipped?: boolean;
  }>;
}

export interface CaptureScreenshotResult {
  png: Uint8Array;
  filename: string;
  /** Always "local"; kept on the result so JSON output stays stable. */
  backend: "local";
  /**
   * Present when `fullPage` was requested with a nonzero max-height cap
   * (explicit or default). `clipped` tells the
   * caller whether the cap actually kicked in, so it can print the
   * "exceeds Npx; clipped" note and JSON `hint` (issue #652).
   */
  capped?: { maxHeightPx: number; clipped: boolean };
}

/**
 * The "clipped by the max-height cap" note shared by the CLI's stderr
 * message and the MCP tool's JSON `hint` field (issue #652) — identical
 * except for how each surface names the flag to raise the cap.
 */
export function clipHintText(maxHeightPx: number, flagName: string): string {
  return `full page exceeds ${maxHeightPx}px; clipped — use ${flagName} to raise`;
}

/** Derives a filename from a URL (host+path) or the source .html filename. */
function deriveFilename(target: ScreenshotTarget): string {
  if (target.kind === "html-file") {
    const stem = basename(target.path).replace(/\.html?$/i, "");
    return sanitizeFilename(`${stem || "screenshot"}.png`);
  }
  const url = new URL(target.url);
  const pathPart = url.pathname.replace(/\/+$/, "").replace(/^\/+/, "");
  const stem = [url.hostname, pathPart].filter(Boolean).join("-");
  // `127.0.0.1/admin` → `127-0-0-1-admin.png`: only the extension keeps a dot.
  return sanitizeFilename(`${stem || "screenshot"}.png`);
}

/**
 * Folds a `--state` value into an auto-derived filename's stem, e.g.
 * `localhost-docs-mcp.png` + "before" → `localhost-docs-mcp-before.png`. This
 * is what keeps a before/after pair (same URL, two states) from colliding on
 * the same object key (issue #618) — without it, the second capture silently
 * overwrote the first.
 *
 * No-op when `state` is undefined, and idempotent: re-folding a filename that
 * already ends with `-<state>` (e.g. re-deriving from a stored filename)
 * doesn't double-append.
 *
 * Only the canonical state values fold. Callers pass the merged metadata bag's
 * `state`, which a free-form `--meta state=…` can populate with any printable
 * ASCII (validateMetaMap allows `/` and spaces) — that stays metadata-only
 * rather than entering the object key.
 *
 * Callers must skip this entirely when the caller gave an explicit key/name
 * (e.g. `--key`) — this only applies to the auto-derived filename.
 */
export function foldStateIntoFilename(filename: string, state: string | undefined): string {
  if (!state || !isMetaStateValue(state)) return filename;
  const match = /^(.*?)(\.[^./]+)?$/.exec(filename);
  const stem = match?.[1] ?? filename;
  const ext = match?.[2] ?? "";
  if (stem.endsWith(`-${state}`)) return filename;
  return `${stem}-${state}${ext}`;
}

/**
 * Resolve target + options into PNG bytes via the local browser.
 * Shared by the CLI `screenshot` command and the MCP `screenshot` tool.
 */
export async function captureScreenshot(
  opts: CaptureScreenshotOptions,
): Promise<CaptureScreenshotResult> {
  const target = classifyTarget(opts.target);
  const viewport = opts.viewport ?? DEFAULT_SCREENSHOT_VIEWPORT;
  const waitUntil = opts.waitUntil ?? "load";
  const filename = foldStateIntoFilename(deriveFilename(target), opts.state);

  // Auto-hide framework dev toolbars only makes sense for a running dev server
  // (a localhost/private URL); default off elsewhere. Combine with any
  // explicit --hide selectors into one list.
  const localOnly = target.kind === "url" && target.localOnly;
  const autoHideDevTools = opts.hideDevTools ?? localOnly;
  for (const sel of opts.hide ?? []) assertHideSelector(sel);
  for (const sel of opts.redact ?? []) assertHideSelector(sel, "redact");
  const hide = [...(opts.hide ?? []), ...(autoHideDevTools ? DEV_TOOLBAR_SELECTORS : [])];

  // Full-page height cap (issue #652): only meaningful with fullPage. 0
  // (explicit --max-height 0) means uncapped; undefined applies the default.
  const effectiveMaxHeight = opts.fullPage ? (opts.maxHeight ?? DEFAULT_FULL_PAGE_MAX_HEIGHT) : 0;

  const captureLocalImpl =
    opts.captureLocalImpl ??
    (async (localOpts) => {
      const { captureLocal } = await import("./screenshot-local.js");
      return captureLocal(localOpts);
    });
  const localResult = await captureLocalImpl({
    url: target.kind === "html-file" ? pathToFileURL(target.path).href : target.url,
    browserPath: opts.browserPath,
    cdp: opts.cdp,
    viewport,
    selector: opts.selector,
    fullPage: opts.fullPage,
    maxHeightPx: effectiveMaxHeight,
    colorScheme: opts.colorScheme,
    waitUntil,
    hide,
    ...(opts.redact && opts.redact.length > 0 ? { redact: opts.redact } : {}),
    reducedMotion: opts.reducedMotion,
    waitForExpr: opts.waitForExpr,
    evalJs: opts.evalJs,
    initScript: opts.initScript,
    detectRoots: opts.detectRoots,
  });
  const capped =
    opts.fullPage && effectiveMaxHeight > 0
      ? { maxHeightPx: effectiveMaxHeight, clipped: localResult.clipped === true }
      : undefined;
  return { png: localResult.png, filename, backend: "local", capped };
}
