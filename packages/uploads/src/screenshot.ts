/**
 * Shared screenshot capture core: target classification, backend selection,
 * and dispatch to the local (playwright-core, dynamic import) or remote
 * (render endpoint) backend. Used by both the CLI command and the MCP tool.
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
import { isMetaStateValue } from "./metadata-vocab.js";
import { captureRemote, MAX_REMOTE_HTML_BYTES } from "./screenshot-remote.js";
import type { DetectRoots } from "./screenshot-local.js";

export type ScreenshotBackend = "auto" | "local" | "remote";
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
 * Reject a `--hide` selector that could break out of the generated
 * `selector{display:none}` rule (or inject markup server-side). The selectors
 * are the caller's own, so this guards against footguns, not a trust boundary.
 * `@` is rejected too: a leading at-rule (e.g. `@import url(...);*`) needs no
 * braces to smuggle an `@import` into the injected stylesheet — and `@` is
 * never valid in a CSS selector anyway.
 */
export function assertHideSelector(selector: string): void {
  if (selector.length === 0 || /[@{}<>]/.test(selector)) {
    throw new UploadsError(
      `invalid hide selector: ${JSON.stringify(selector)} (a CSS selector, no @, {, }, <, or >)`,
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

/** IPv4 loopback/private/link-local ranges. Mirrors the server's isPrivateRenderTarget. */
const PRIVATE_IPV4_RE =
  /^(127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+)$/;

/** Hostname forms treated as local/private regardless of DNS resolution. */
const PRIVATE_HOSTNAME_RE = /^((.+\.)?localhost|.+\.local|.+\.internal)$/i;

/** IPv6 unique local addresses, fc00::/7 (RFC 4193). */
const IPV6_ULA_RE = /^f[cd][0-9a-f]{2}:/i;

/** IPv6 link-local addresses, fe80::/10. */
const IPV6_LINK_LOCAL_RE = /^fe[89ab][0-9a-f]:/i;

function isPrivateIPv4(host: string): boolean {
  return PRIVATE_IPV4_RE.test(host);
}

/**
 * True for localhost / private-network / link-local hosts — only reachable
 * by the local backend. Accepts a bare hostname or an IPv6 literal with its
 * brackets still attached (as returned by `new URL(...).hostname`, e.g.
 * `"[::1]"`). Mirrors the server's `isPrivateRenderTarget` so `--via remote`
 * fails fast for the same targets the render endpoint itself would reject.
 */
export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = /^\[.+\]$/.test(hostname) ? hostname.slice(1, -1) : hostname;

  if (isPrivateIPv4(host)) return true;
  if (PRIVATE_HOSTNAME_RE.test(host)) return true;
  if (host === "::1" || host === "::") return true;
  if (IPV6_ULA_RE.test(host)) return true;
  if (IPV6_LINK_LOCAL_RE.test(host)) return true;

  // IPv4-mapped IPv6, e.g. "::ffff:10.0.0.1" or "::ffff:a00:1" — private iff
  // the mapped IPv4 quad is private.
  const mapped = /^::ffff:(.+)$/i.exec(host);
  if (mapped) {
    const rest = mapped[1]!;
    if (isPrivateIPv4(rest)) return true;
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
    if (hex) {
      const hi = Number.parseInt(hex[1]!, 16);
      const lo = Number.parseInt(hex[2]!, 16);
      const a = (hi >> 8) & 0xff;
      const b = hi & 0xff;
      const c = (lo >> 8) & 0xff;
      const d = lo & 0xff;
      if (isPrivateIPv4(`${a}.${b}.${c}.${d}`)) return true;
    }
  }

  return false;
}

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

/** A measured element box in device (raster) pixels — CSS pixels × deviceScaleFactor. */
export interface MeasuredBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CaptureScreenshotOptions {
  target: string;
  via: ScreenshotBackend;
  browserPath?: string;
  cdp?: string;
  viewport?: ScreenshotViewport;
  selector?: string;
  fullPage?: boolean;
  /**
   * Cap (CSS px) on `--full-page` capture height. Only meaningful with
   * `fullPage: true`; ignored otherwise. `undefined` applies
   * `DEFAULT_FULL_PAGE_MAX_HEIGHT`; `0` means uncapped. Wired through both
   * capture backends so behavior matches regardless of `via` (issue #652).
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
   * Auto-hide known framework dev toolbars. Defaults to on for localhost/
   * private-network targets and off otherwise; pass `false` to opt out.
   */
  hideDevTools?: boolean;
  /** Emulate prefers-reduced-motion: reduce so CSS/JS animations settle. */
  reducedMotion?: boolean;
  /** Run this JS in the page after settle, before capture (local backend only). */
  evalJs?: string;
  /** Inject this JS as an init script before navigation (local backend only). */
  initScript?: string;
  /**
   * CSS selectors to measure (getBoundingClientRect, scaled to device pixels)
   * before capture, for resolving annotation-spec selectors. Local backend
   * only — throws if the resolved backend is remote.
   */
  measureSelectors?: string[];
  apiUrl: string;
  token: string;
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
    reducedMotion?: boolean;
    evalJs?: string;
    initScript?: string;
    measureSelectors?: string[];
    detectRoots?: DetectRoots;
    /** Pre-computed detection result from auto-routing, to avoid a second fs scan. */
    detectResult?: import("./screenshot-local.js").DetectResult;
  }) => Promise<{
    png: Uint8Array;
    measures?: Record<string, MeasuredBox>;
    /** Present when `fullPage` + a positive `maxHeightPx` were given. */
    clipped?: boolean;
  }>;
  /** Injectable for tests: replaces the remote capture implementation. */
  captureRemoteImpl?: typeof captureRemote;
}

export interface CaptureScreenshotResult {
  png: Uint8Array;
  filename: string;
  backend: "local" | "remote";
  /** Present when `measureSelectors` was given and the local backend ran. */
  measures?: Record<string, MeasuredBox>;
  /**
   * Present when `fullPage` was requested with a nonzero max-height cap
   * (explicit or default) — regardless of backend. `clipped` tells the
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
    return `${stem || "screenshot"}.png`;
  }
  const url = new URL(target.url);
  const pathPart = url.pathname
    .replace(/\/+$/, "")
    .replace(/^\/+/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-");
  const stem = [url.hostname, pathPart].filter(Boolean).join("-");
  return `${stem || "screenshot"}.png`;
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
 * Best-effort local-browser probe used only to decide `auto` routing. Never
 * throws — any failure (e.g. optional playwright-core not installed) means
 * "no local browser available". Returns the full detection result (not just
 * a boolean) so callers that go on to launch locally can reuse it instead of
 * re-scanning the filesystem a second time.
 */
async function probeLocalBrowser(
  detectRoots: DetectRoots | undefined,
): Promise<import("./screenshot-local.js").DetectResult | undefined> {
  try {
    const { detectLocalBrowser } = await import("./screenshot-local.js");
    return detectLocalBrowser(detectRoots);
  } catch {
    return undefined;
  }
}

/**
 * Resolve target + options into PNG bytes via the local or remote backend.
 * Shared by the CLI `screenshot` command and the MCP `screenshot` tool.
 */
export async function captureScreenshot(
  opts: CaptureScreenshotOptions,
): Promise<CaptureScreenshotResult> {
  const target = classifyTarget(opts.target);
  const viewport = opts.viewport ?? DEFAULT_SCREENSHOT_VIEWPORT;
  const waitUntil = opts.waitUntil ?? "load";
  const filename = foldStateIntoFilename(deriveFilename(target), opts.state);

  // Only private-network URLs are truly unreachable remotely; an .html file
  // is sent to the remote backend as an inline `html` body (though anything
  // it references via file:// or relative paths won't resolve there).
  const localOnly = target.kind === "url" && target.localOnly;

  // Auto-hide framework dev toolbars only makes sense for a running dev server
  // (a localhost/private URL); default off elsewhere. Combine with any
  // explicit --hide selectors into one list shared by both backends.
  const autoHideDevTools = opts.hideDevTools ?? localOnly;
  for (const sel of opts.hide ?? []) assertHideSelector(sel);
  const hide = [...(opts.hide ?? []), ...(autoHideDevTools ? DEV_TOOLBAR_SELECTORS : [])];

  // Full-page height cap (issue #652): only meaningful with fullPage. 0
  // (explicit --max-height 0) means uncapped; undefined applies the default.
  const effectiveMaxHeight = opts.fullPage ? (opts.maxHeight ?? DEFAULT_FULL_PAGE_MAX_HEIGHT) : 0;

  // Shared by both backends below — only meaningful when fullPage capped at
  // a positive height; `clipped` is the one thing that differs per backend.
  const cappedFrom = (clipped: boolean): CaptureScreenshotResult["capped"] =>
    opts.fullPage && effectiveMaxHeight > 0
      ? { maxHeightPx: effectiveMaxHeight, clipped }
      : undefined;

  // Populated only when auto-routing actually probes the filesystem, so it
  // can be threaded into captureLocalImpl below to avoid a second scan.
  let detected: import("./screenshot-local.js").DetectResult | undefined;

  let backend: "local" | "remote";
  if (opts.via === "local") {
    backend = "local";
  } else if (opts.via === "remote") {
    if (localOnly) {
      throw new UploadsError(
        `${opts.target} is only reachable by the local backend (localhost/private network, or a local file) — use --via local`,
        "USAGE",
      );
    }
    backend = "remote";
  } else {
    // auto
    detected = await probeLocalBrowser(opts.detectRoots);
    const available = Boolean(detected?.winner);
    if (localOnly) {
      if (!available) {
        throw new UploadsError(
          `${opts.target} is only reachable by the local backend, but no local browser was found — install Chrome or run \`npx playwright install chromium\``,
          "BROWSER_NOT_FOUND",
        );
      }
      backend = "local";
    } else {
      backend = available ? "local" : "remote";
    }
  }

  // Numeric --wait is a fixed post-load settle delay the local Playwright
  // page can honor directly; the remote render endpoint only understands the
  // named strategies, so fail fast instead of silently ignoring the delay.
  if (backend === "remote" && typeof waitUntil === "number") {
    throw new UploadsError(
      `numeric --wait (${waitUntil}ms) is local-only — use --via local, or one of load/domcontentloaded/networkidle for the remote backend`,
      "USAGE",
    );
  }

  // Arbitrary pre-capture JS runs only on the local backend — the shared
  // remote renderer intentionally has no eval escape hatch (different security
  // posture). Fail fast rather than silently dropping it.
  if (backend === "remote" && (opts.evalJs !== undefined || opts.initScript !== undefined)) {
    throw new UploadsError("--eval and --init-script are local-only — use --via local", "USAGE");
  }

  // Selector-based annotation measurement needs a live local page — the
  // remote render endpoint has no eval escape hatch to run
  // getBoundingClientRect. Covers both explicit --via remote and auto
  // resolving to remote.
  if (backend === "remote" && opts.measureSelectors && opts.measureSelectors.length > 0) {
    throw new UploadsError("selector annotations need --via local in v1", "USAGE");
  }

  if (backend === "local") {
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
      reducedMotion: opts.reducedMotion,
      evalJs: opts.evalJs,
      initScript: opts.initScript,
      measureSelectors: opts.measureSelectors,
      detectRoots: opts.detectRoots,
      detectResult: detected,
    });
    const capped = cappedFrom(localResult.clipped === true);
    return { png: localResult.png, filename, backend, measures: localResult.measures, capped };
  }

  if (target.kind === "html-file") {
    const bytes = new TextEncoder().encode(target.html).byteLength;
    if (bytes > MAX_REMOTE_HTML_BYTES) {
      throw new UploadsError(
        `${opts.target} is ${bytes} bytes, over the remote backend's ${MAX_REMOTE_HTML_BYTES} byte limit — use --via local`,
        "USAGE",
      );
    }
  }

  const captureRemoteImpl = opts.captureRemoteImpl ?? captureRemote;
  const remoteResult = await captureRemoteImpl(
    {
      ...(target.kind === "html-file" ? { html: target.html } : { url: target.url }),
      viewport,
      selector: opts.selector,
      fullPage: opts.fullPage,
      ...(opts.fullPage && effectiveMaxHeight > 0 ? { maxHeight: effectiveMaxHeight } : {}),
      colorScheme: opts.colorScheme,
      waitUntil,
      ...(hide.length > 0 ? { hide } : {}),
      ...(opts.reducedMotion ? { reducedMotion: true } : {}),
    },
    { apiUrl: opts.apiUrl, token: opts.token },
  );
  const capped = cappedFrom(remoteResult.clipped === true);
  return { png: remoteResult.png, filename, backend, capped };
}
