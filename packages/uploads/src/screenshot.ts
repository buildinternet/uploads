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
import { captureRemote, MAX_REMOTE_HTML_BYTES } from "./screenshot-remote.js";
import type { DetectRoots } from "./screenshot-local.js";

export type ScreenshotBackend = "auto" | "local" | "remote";
export type WaitUntil = "load" | "domcontentloaded" | "networkidle" | number;

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

export interface CaptureScreenshotOptions {
  target: string;
  via: ScreenshotBackend;
  browserPath?: string;
  cdp?: string;
  viewport?: ScreenshotViewport;
  selector?: string;
  fullPage?: boolean;
  colorScheme?: "dark" | "light";
  waitUntil?: WaitUntil;
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
    colorScheme?: "dark" | "light";
    waitUntil: WaitUntil;
    detectRoots?: DetectRoots;
    /** Pre-computed detection result from auto-routing, to avoid a second fs scan. */
    detectResult?: import("./screenshot-local.js").DetectResult;
  }) => Promise<Uint8Array>;
  /** Injectable for tests: replaces the remote capture implementation. */
  captureRemoteImpl?: typeof captureRemote;
}

export interface CaptureScreenshotResult {
  png: Uint8Array;
  filename: string;
  backend: "local" | "remote";
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
  const filename = deriveFilename(target);

  const localOnly = target.kind === "html-file" || target.localOnly;

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

  if (backend === "local") {
    const captureLocalImpl =
      opts.captureLocalImpl ??
      (async (localOpts) => {
        const { captureLocal } = await import("./screenshot-local.js");
        return captureLocal(localOpts);
      });
    const png = await captureLocalImpl({
      url: target.kind === "html-file" ? pathToFileURL(target.path).href : target.url,
      browserPath: opts.browserPath,
      cdp: opts.cdp,
      viewport,
      selector: opts.selector,
      fullPage: opts.fullPage,
      colorScheme: opts.colorScheme,
      waitUntil,
      detectRoots: opts.detectRoots,
      detectResult: detected,
    });
    return { png, filename, backend };
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
  const png = await captureRemoteImpl(
    {
      ...(target.kind === "html-file" ? { html: target.html } : { url: target.url }),
      viewport,
      selector: opts.selector,
      fullPage: opts.fullPage,
      colorScheme: opts.colorScheme,
      waitUntil,
    },
    { apiUrl: opts.apiUrl, token: opts.token },
  );
  return { png, filename, backend };
}
