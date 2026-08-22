/**
 * POST /v1/render (phase 1): renders a URL or raw HTML to a PNG via the
 * Cloudflare Browser Run binding and returns the bytes directly — no R2
 * write. See `.context/2026-07-16-render-endpoint-brief.md` for the full
 * spec and `.context/2026-07-16-cli-screenshot-render-pipeline.md` for the
 * surrounding CLI pipeline this feeds.
 *
 * This module owns two things kept deliberately separate:
 *  - request validation (`parseRenderRequest`): pure, no bindings, easy to
 *    unit test without a Worker environment.
 *  - the `Renderer` seam (`browserRenderer`): wraps `env.BROWSER.quickAction`.
 *    Routes depend on the `Renderer` interface, never on `BrowserRun`
 *    directly, so tests can substitute a `FakeBrowser` — quickAction has no
 *    Miniflare/local simulation (it requires `"remote": true` and proxies to
 *    the real metered service), so this seam is required, not a nicety.
 */
import { AppError, PayloadTooLargeError, RateLimitedError, ValidationError } from "@uploads/errors";

/** Max size of a raw `html` body. Declared separately from the outer request
 * body cap (`routes/render.ts`) so the two limits can't silently drift. */
export const MAX_RENDER_HTML_BYTES = 2 * 1024 * 1024; // 2 MiB

const MIN_VIEWPORT_DIMENSION = 16;
const MAX_VIEWPORT_DIMENSION = 4096;
const MIN_DEVICE_SCALE_FACTOR = 1;
const MAX_DEVICE_SCALE_FACTOR = 3;

/**
 * Default cap (CSS px) on `fullPage` capture height (issue #652): a
 * deliberately independent, conservative fallback for direct API callers
 * that omit `maxHeight` — 5000, matches the CLI default as of writing; no
 * compile-time link — the CLI always sends an explicit value, and apps/api
 * intentionally does not depend on packages/uploads, so nothing enforces
 * the two stay in sync.
 */
const DEFAULT_FULL_PAGE_MAX_HEIGHT = 5000;
/** Sanity ceiling on a caller-supplied `maxHeight`, well above the default. */
const MAX_FULL_PAGE_MAX_HEIGHT = 20_000;

/** Navigation timeout handed to Browser Run — below its 60s ceiling. */
const NAVIGATION_TIMEOUT_MS = 30_000;
/** Upstream cap on the post-load action (screenshot) so Browser Run can't
 *  keep a billed session running after the handler's own window lapses. */
const ACTION_TIMEOUT_MS = 30_000;
/** Safety margin above `NAVIGATION_TIMEOUT_MS` for the local handler-side race,
 * in case Browser Run hangs without ever resolving `quickAction`'s promise. */
const HANDLER_TIMEOUT_MS = 35_000;

export interface RenderViewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

/** Cap on `hide` selectors — a screenshot never needs many, and it bounds the
 * injected-stylesheet size. */
const MAX_HIDE_SELECTORS = 50;

/**
 * Neutralizes CSS/JS animations and transitions so a page settles to its
 * finished state deterministically. Browser Run's typed surface has no
 * prefers-reduced-motion / emulateMediaFeatures option (only emulateMediaType +
 * addStyleTag), so `reducedMotion` is a documented best-effort here — the same
 * kind of gap as `colorScheme`. It forces end-state rather than honoring a
 * page's own reduced-motion rules, which is what our screenshot use case wants.
 */
const REDUCED_MOTION_CSS =
  "*,*::before,*::after{animation-duration:0s !important;animation-delay:0s !important;animation-iteration-count:1 !important;transition-duration:0s !important;transition-delay:0s !important;scroll-behavior:auto !important}";

export interface RenderInput {
  url?: string;
  html?: string;
  viewport?: RenderViewport;
  selector?: string;
  fullPage?: boolean;
  /**
   * Cap (CSS px) on `fullPage` capture height (issue #652). Only consulted
   * when `fullPage` is true; `0` means uncapped. Defaults to
   * `DEFAULT_FULL_PAGE_MAX_HEIGHT` when `fullPage` is true and this is
   * omitted (the CLI always sends it explicitly).
   */
  maxHeight?: number;
  colorScheme?: "dark" | "light";
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  hide?: string[];
  reducedMotion?: boolean;
}

export interface RenderResult {
  png: Uint8Array;
  contentType: string;
  /**
   * True when the `fullPage` height clamp actually kicked in. Best-effort:
   * Browser Run's quick-action surface has no direct "measure then clip"
   * primitive, so this is inferred from the returned image's decoded height
   * rather than known with certainty — see `toBrowserRunOptions` and
   * `browserRenderer` below for the full explanation.
   */
  clipped?: boolean;
}

export interface Renderer {
  screenshot(input: RenderInput): Promise<RenderResult>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * True for hostnames that resolve (by literal form, not DNS) to a private,
 * loopback, or link-local network, plus the conventional `.internal`/`.local`
 * TLDs. DNS-rebinding-grade resolution is out of scope — Cloudflare's browser
 * runs isolated from our infra, so the risk here is "don't hand an agent a
 * pivot into our own network," not a full SSRF hardening pass.
 */
/** Parses a dotted-quad IPv4 literal into its four octets, or `null`. */
function parseIpv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (octets.some((o) => o > 255)) return null;
  return octets as [number, number, number, number];
}

/**
 * Parses the trailing 32 bits of an IPv4-mapped IPv6 address (the part after
 * `::ffff:`) into dotted-quad octets. Accepts both forms the wire can carry:
 * the dotted form (`127.0.0.1`) and the hex-group form (`7f00:1`) that `URL`
 * normalizes dotted IPv4-mapped addresses into (verified:
 * `new URL("http://[::ffff:127.0.0.1]/").hostname` → `[::ffff:7f00:1]`).
 */
function parseIpv4MappedTail(tail: string): [number, number, number, number] | null {
  const dotted = parseIpv4(tail);
  if (dotted) return dotted;

  const hexParts = tail.split(":");
  if (hexParts.length !== 2 || hexParts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  const hi = Number.parseInt(hexParts[0], 16);
  const lo = Number.parseInt(hexParts[1], 16);
  const value = (hi << 16) | lo;
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** True for the private/loopback/link-local IPv4 ranges we block. */
function isPrivateIpv4([a, b]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 ("this network" / unspecified)
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (incl. cloud metadata)
  return false;
}

export function isPrivateRenderTarget(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;
  if (host === "::1") return true;

  const ipv4 = parseIpv4(host);
  if (ipv4) return isPrivateIpv4(ipv4);

  // IPv4-mapped IPv6 (::ffff:a.b.c.d or its ::ffff:xxxx:yyyy hex-normalized
  // form) — decode the trailing 32 bits and re-run the IPv4 range checks.
  const mapped = /^::ffff:(.+)$/.exec(host);
  if (mapped) {
    const tail = parseIpv4MappedTail(mapped[1]);
    if (tail) return isPrivateIpv4(tail);
  }

  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true; // fe80::/10 link-local

  return false;
}

/**
 * Validates a parsed JSON body into a `RenderInput`. Throws `ValidationError`
 * (code `invalid_request`) or `PayloadTooLargeError` (code `upload_too_large`,
 * matching the existing oversized-payload convention in guards.ts) on any
 * malformed input.
 */
export function parseRenderRequest(parsed: unknown): RenderInput {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError("request body must be a JSON object", { code: "invalid_request" });
  }
  const body = parsed as Record<string, unknown>;

  const hasUrl = typeof body.url === "string" && body.url.length > 0;
  const hasHtml = typeof body.html === "string" && body.html.length > 0;
  if (hasUrl === hasHtml) {
    throw new ValidationError("exactly one of url or html is required", {
      code: "invalid_request",
    });
  }

  const input: RenderInput = {};

  if (hasUrl) {
    const rawUrl = body.url as string;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      throw new ValidationError("url must be a valid absolute URL", { code: "invalid_request" });
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new ValidationError("url must be http or https", { code: "invalid_request" });
    }
    if (isPrivateRenderTarget(parsedUrl.hostname)) {
      throw new ValidationError("url targets a private or internal network", {
        code: "invalid_request",
      });
    }
    input.url = rawUrl;
  } else {
    const html = body.html as string;
    const byteLength = new TextEncoder().encode(html).byteLength;
    if (byteLength > MAX_RENDER_HTML_BYTES) {
      throw new PayloadTooLargeError("html body too large", {
        code: "upload_too_large",
        details: { maxBytes: MAX_RENDER_HTML_BYTES },
      });
    }
    input.html = html;
  }

  if (body.viewport !== undefined) {
    if (
      typeof body.viewport !== "object" ||
      body.viewport === null ||
      Array.isArray(body.viewport)
    ) {
      throw new ValidationError("viewport must be an object", { code: "invalid_request" });
    }
    const v = body.viewport as Record<string, unknown>;
    if (typeof v.width !== "number" || typeof v.height !== "number") {
      throw new ValidationError("viewport.width and viewport.height must be numbers", {
        code: "invalid_request",
      });
    }
    const viewport: RenderViewport = {
      width: clamp(Math.round(v.width), MIN_VIEWPORT_DIMENSION, MAX_VIEWPORT_DIMENSION),
      height: clamp(Math.round(v.height), MIN_VIEWPORT_DIMENSION, MAX_VIEWPORT_DIMENSION),
    };
    if (v.deviceScaleFactor !== undefined) {
      if (typeof v.deviceScaleFactor !== "number") {
        throw new ValidationError("viewport.deviceScaleFactor must be a number", {
          code: "invalid_request",
        });
      }
      viewport.deviceScaleFactor = clamp(
        v.deviceScaleFactor,
        MIN_DEVICE_SCALE_FACTOR,
        MAX_DEVICE_SCALE_FACTOR,
      );
    }
    input.viewport = viewport;
  }

  if (body.selector !== undefined) {
    if (typeof body.selector !== "string" || body.selector.length === 0) {
      throw new ValidationError("selector must be a non-empty string", { code: "invalid_request" });
    }
    input.selector = body.selector;
  }

  if (body.fullPage !== undefined) {
    if (typeof body.fullPage !== "boolean") {
      throw new ValidationError("fullPage must be a boolean", { code: "invalid_request" });
    }
    input.fullPage = body.fullPage;
  }

  if (body.maxHeight !== undefined) {
    if (
      typeof body.maxHeight !== "number" ||
      !Number.isFinite(body.maxHeight) ||
      body.maxHeight < 0
    ) {
      throw new ValidationError("maxHeight must be a non-negative number", {
        code: "invalid_request",
      });
    }
    input.maxHeight =
      body.maxHeight === 0 ? 0 : clamp(Math.round(body.maxHeight), 1, MAX_FULL_PAGE_MAX_HEIGHT);
  }

  if (body.colorScheme !== undefined) {
    if (body.colorScheme !== "dark" && body.colorScheme !== "light") {
      throw new ValidationError('colorScheme must be "dark" or "light"', {
        code: "invalid_request",
      });
    }
    input.colorScheme = body.colorScheme;
  }

  if (body.waitUntil !== undefined) {
    if (
      body.waitUntil !== "load" &&
      body.waitUntil !== "domcontentloaded" &&
      body.waitUntil !== "networkidle"
    ) {
      throw new ValidationError('waitUntil must be "load", "domcontentloaded", or "networkidle"', {
        code: "invalid_request",
      });
    }
    input.waitUntil = body.waitUntil;
  }

  if (body.hide !== undefined) {
    if (!Array.isArray(body.hide)) {
      throw new ValidationError("hide must be an array of CSS selectors", {
        code: "invalid_request",
      });
    }
    if (body.hide.length > MAX_HIDE_SELECTORS) {
      throw new ValidationError(`hide accepts at most ${MAX_HIDE_SELECTORS} selectors`, {
        code: "invalid_request",
      });
    }
    for (const sel of body.hide) {
      // Non-empty, and can't break out of the generated `sel{display:none}`
      // rule or inject markup via the addStyleTag content. `@` is rejected so a
      // leading at-rule (`@import url(...);*`) can't smuggle an `@import` into
      // the injected stylesheet — mirrors assertHideSelector in the SDK.
      if (typeof sel !== "string" || sel.length === 0 || /[@{}<>]/.test(sel)) {
        throw new ValidationError("each hide selector must be a plain CSS selector string", {
          code: "invalid_request",
        });
      }
    }
    input.hide = body.hide as string[];
  }

  if (body.reducedMotion !== undefined) {
    if (typeof body.reducedMotion !== "boolean") {
      throw new ValidationError("reducedMotion must be a boolean", { code: "invalid_request" });
    }
    input.reducedMotion = body.reducedMotion;
  }

  return input;
}

/** CSS px cap actually in force for this request; 0 means uncapped. */
function effectiveFullPageMaxHeight(input: RenderInput): number {
  if (!input.fullPage) return 0;
  return input.maxHeight ?? DEFAULT_FULL_PAGE_MAX_HEIGHT;
}

/**
 * JS injected (via `addScriptTag`) to bound a `fullPage` capture's height
 * server-side (issue #652). Browser Run's quick-action surface is
 * declarative (goto → tag injection → one screenshot action) with no
 * "measure the page, then decide" step, so there's no direct way to ask for
 * "fullPage, but capped at Npx" the way Playwright's `page.screenshot`
 * would locally (see packages/uploads/src/screenshot-local.ts). Instead,
 * this measures `scrollHeight` client-side and — only when it exceeds the
 * cap — clamps `<html>`/`<body>` to exactly `capPx` with `overflow: hidden`
 * before the screenshot action runs, so Puppeteer's own `fullPage`
 * measurement (which reads the now-clamped scrollHeight) produces an image
 * that's never taller than the cap. A page under the cap is untouched, so
 * the common case still gets its normal exact-content-height capture.
 *
 * Known best-effort limitations (documented, not solved): `overflow: hidden`
 * on the root elements can affect `position: fixed`/`sticky` elements and
 * viewport-unit layouts on a page that gets clamped; there's no scroll-then-
 * clip like the local backend's `clip` fallback, so a clamped remote capture
 * is a true DOM truncation rather than a pixel-region crop.
 */
function fullPageClampScript(capPx: number): string {
  return (
    "(function(){try{" +
    "var d=document.documentElement,b=document.body;" +
    `var h=Math.max(d?d.scrollHeight:0,b?b.scrollHeight:0);var cap=${capPx};` +
    "if(h>cap){[d,b].forEach(function(el){if(!el)return;" +
    "el.style.setProperty('max-height',cap+'px','important');" +
    "el.style.setProperty('overflow','hidden','important');});}" +
    "}catch(e){}})();"
  );
}

function toBrowserRunOptions(input: RenderInput): BrowserRunScreenshotOptions {
  const base = (input.url !== undefined ? { url: input.url } : { html: input.html as string }) as
    | { url: string }
    | { html: string };

  // Cloudflare's own lifecycle events are the puppeteer set
  // (load/domcontentloaded/networkidle0/networkidle2); our wire contract
  // exposes "load" (default), "domcontentloaded" (passed straight through —
  // it's already a Browser Run/puppeteer lifecycle value), and "networkidle".
  // "networkidle2" (<=2 in-flight connections for 500ms) is the closer match
  // to "networkidle" as commonly understood than the stricter networkidle0 —
  // CF's docs note ~4.5s effective cap on top of gotoOptions.timeout
  // regardless. Numeric waits stay unsupported server-side (the CLI rejects
  // them client-side for remote renders).
  const waitUntil: BrowserRunLifecycleEvent =
    input.waitUntil === "networkidle"
      ? "networkidle2"
      : input.waitUntil === "domcontentloaded"
        ? "domcontentloaded"
        : "load";

  const options: BrowserRunScreenshotOptions = {
    ...base,
    gotoOptions: { timeout: NAVIGATION_TIMEOUT_MS, waitUntil },
    // Bound the post-load action upstream too: withTimeout() only stops the
    // handler waiting — without this, Browser Run keeps the (billed) action
    // running past our window.
    actionTimeout: ACTION_TIMEOUT_MS,
    screenshotOptions: { type: "png", fullPage: input.fullPage ?? false },
  } as BrowserRunScreenshotOptions;

  if (input.selector !== undefined) options.selector = input.selector;
  if (input.viewport !== undefined) {
    options.viewport = {
      width: input.viewport.width,
      height: input.viewport.height,
      ...(input.viewport.deviceScaleFactor !== undefined
        ? { deviceScaleFactor: input.viewport.deviceScaleFactor }
        : {}),
    };
  }
  // Browser Run's typed surface only exposes `addStyleTag` (+ emulateMediaType)
  // for media/appearance control, so colorScheme, hide, and reduced-motion all
  // flow through injected stylesheets. Accumulate into one array.
  const styleTags: { content: string }[] = [];
  if (input.colorScheme !== undefined) {
    // DEVIATION (see RESULT.md): quickAction's typed surface has no
    // prefers-color-scheme / emulateMediaFeatures option — only
    // `emulateMediaType` (screen/print). We inject a `color-scheme` CSS
    // property as a best effort, which affects native form controls and
    // scrollbars but can NOT force a page's own `prefers-color-scheme` media
    // query to match (that reflects the browser's OS-level signal, which an
    // injected stylesheet cannot spoof). Good enough for our own
    // `screenshots/` templated-card use case; documented as a known gap for
    // arbitrary third-party pages.
    styleTags.push({ content: `:root{color-scheme:${input.colorScheme};}` });
  }
  if (input.hide !== undefined && input.hide.length > 0) {
    styleTags.push({ content: `${input.hide.join(",")}{display:none !important}` });
  }
  if (input.reducedMotion) {
    styleTags.push({ content: REDUCED_MOTION_CSS });
  }
  if (styleTags.length > 0) options.addStyleTag = styleTags;

  const maxHeightPx = effectiveFullPageMaxHeight(input);
  if (maxHeightPx > 0) {
    options.addScriptTag = [{ content: fullPageClampScript(maxHeightPx) }];
  }

  return options;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new AppError({
          type: "unavailable",
          code: "render_failed",
          message: "render timed out",
          status: 504,
        }),
      );
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads a PNG's pixel dimensions straight from its IHDR chunk (bytes 16-23,
 * big-endian uint32 width then height) — the 8-byte PNG signature plus the
 * fixed 4-byte length + 4-byte "IHDR" type always precede it. No dependency
 * needed; returns `undefined` for anything that isn't a well-formed PNG
 * header instead of throwing, since this only feeds a best-effort clip
 * heuristic below.
 */
function decodePngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24) return undefined;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width === 0 || height === 0) return undefined;
  return { width, height };
}

/**
 * Wraps the Browser Run `BROWSER` binding behind the `Renderer` seam.
 * `BROWSER` is an optional binding (uploads#754 item 3 — self-hosters can
 * skip it): an absent binding degrades this single endpoint to a 503 with a
 * distinct `renderer_unavailable` code, never a worker crash. This used to be
 * only *incidentally* fail-soft — `browser.quickAction` throwing a `TypeError`
 * on `undefined` happened to land in the catch below as a generic
 * `render_failed` 502 — so the explicit check here is for a clearer signal to
 * callers, not a behavior fix.
 */
export function browserRenderer(browser: BrowserRun | undefined): Renderer {
  return {
    async screenshot(input) {
      if (!browser) {
        throw new AppError({
          type: "unavailable",
          code: "renderer_unavailable",
          message: "screenshot rendering is not configured on this deployment",
          status: 503,
        });
      }
      const options = toBrowserRunOptions(input);
      let response: Response;
      try {
        response = await withTimeout(
          browser.quickAction("screenshot", options),
          HANDLER_TIMEOUT_MS,
        );
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError({
          type: "unavailable",
          code: "render_failed",
          message: "render failed",
          status: 502,
          cause: err,
        });
      }

      if (!response.ok) {
        let detail: unknown;
        try {
          detail = await response.clone().json();
        } catch {
          detail = undefined;
        }
        if (response.status === 429) {
          throw new RateLimitedError("browser render rate limited upstream", {
            code: "rate_limited",
            details: detail,
          });
        }
        if (response.status === 400 || response.status === 422) {
          throw new ValidationError("render request rejected by the browser", {
            code: "render_failed",
            details: detail,
          });
        }
        throw new AppError({
          type: "unavailable",
          code: "render_failed",
          message: "render failed",
          status: 502,
          details: detail,
        });
      }

      const contentType = response.headers.get("content-type") ?? "image/png";
      const png = new Uint8Array(await response.arrayBuffer());

      // Best-effort clip detection (issue #652): the clamp script above
      // either did nothing (page was already under the cap) or pinned the
      // rendered height to exactly capPx — decoding the returned image's
      // height and comparing against capPx (in device px, with rounding
      // slack) distinguishes the two without needing feedback from the page
      // script itself, which quickAction's declarative surface has no way
      // to return.
      const maxHeightPx = effectiveFullPageMaxHeight(input);
      let clipped = false;
      if (maxHeightPx > 0) {
        const dims = decodePngDimensions(png);
        if (dims) {
          const dsf = input.viewport?.deviceScaleFactor ?? 1;
          const cssHeight = dims.height / dsf;
          clipped = cssHeight >= maxHeightPx - 2;
        }
      }

      return { png, contentType, clipped };
    },
  };
}
