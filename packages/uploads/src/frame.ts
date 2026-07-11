/**
 * Optional device/browser frames for put/attach.
 *
 * Default off. Procedural `phone` / `browser` ship with no third-party assets.
 * Named device presets fetch frame+mask from the open
 * [device-frames-media](https://github.com/jonnyjackson26/device-frames-media)
 * set (cached under the user cache dir) — not redistributed in the npm tarball
 * until license redistributability is clearer.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

export type FrameFit = "cover" | "contain";

export interface FrameOptions {
  /** Preset id: phone | browser | iphone-16-pro | … */
  id: string;
  fit?: FrameFit;
  /** Optional URL shown in the procedural browser chrome. */
  browserUrl?: string;
  /** Injected for tests (skip network). */
  fetchImpl?: typeof fetch;
  /** Override cache root (tests). */
  cacheDir?: string;
}

export interface FrameResult {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
  framed: boolean;
  frameId: string;
  skippedReason?: string;
}

interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RemoteDevicePreset {
  kind: "remote";
  label: string;
  /** Directory URL (no trailing slash) hosting frame.png + mask.png */
  assetBase: string;
  screen: ScreenRect;
  frameSize: { width: number; height: number };
  attribution: string;
}

interface ProceduralPreset {
  kind: "procedural";
  label: string;
}

type FramePreset = ProceduralPreset | RemoteDevicePreset;

/**
 * Built-in frame catalog. Remote presets use community PNGs at fetch time.
 * @see https://github.com/jonnyjackson26/device-frames-media
 */
export const FRAME_PRESETS: Record<string, FramePreset> = {
  phone: { kind: "procedural", label: "Generic phone bezel (procedural)" },
  browser: { kind: "procedural", label: "Generic browser chrome (procedural)" },
  "iphone-16-pro": {
    kind: "remote",
    label: "iPhone 16 Pro (Black Titanium)",
    assetBase:
      "https://raw.githubusercontent.com/jonnyjackson26/device-frames-media/main/device-frames-output/Apple%20iPhone/16%20Pro/Black%20Titanium",
    screen: { x: 102, y: 100, width: 1206, height: 2622 },
    frameSize: { width: 1406, height: 2822 },
    attribution: "Frame art from jonnyjackson26/device-frames-media (fetched at use; not bundled).",
  },
  "iphone-15-pro-max": {
    kind: "remote",
    label: "iPhone 15 Pro Max (Black Titanium)",
    assetBase:
      "https://raw.githubusercontent.com/jonnyjackson26/device-frames-media/main/device-frames-output/Apple%20iPhone/15%20Pro%20Max/Black%20Titanium",
    screen: { x: 100, y: 100, width: 1290, height: 2796 },
    frameSize: { width: 1490, height: 2996 },
    attribution: "Frame art from jonnyjackson26/device-frames-media (fetched at use; not bundled).",
  },
  "pixel-9-pro": {
    kind: "remote",
    label: "Pixel 9 Pro (Obsidian)",
    assetBase:
      "https://raw.githubusercontent.com/jonnyjackson26/device-frames-media/main/device-frames-output/Android%20Phone/Pixel%209%20Pro/Obsidian",
    screen: { x: 170, y: 142, width: 1280, height: 2856 },
    frameSize: { width: 1620, height: 3136 },
    attribution: "Frame art from jonnyjackson26/device-frames-media (fetched at use; not bundled).",
  },
};

// Catalog screen/frameSize are fallbacks; resolveRemoteScreen() prefers
// template.json from the asset base when download succeeds.

export function listFramePresets(): Array<{ id: string; label: string; kind: string }> {
  return Object.entries(FRAME_PRESETS).map(([id, p]) => ({
    id,
    label: p.label,
    kind: p.kind,
  }));
}

export function resolveFrameId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const id = raw.trim().toLowerCase();
  if (!id) return undefined;
  if (!(id in FRAME_PRESETS)) {
    const known = Object.keys(FRAME_PRESETS).join(", ");
    throw new Error(`unknown frame "${raw}" (known: ${known})`);
  }
  return id;
}

function defaultCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(xdg, "uploads", "frames");
}

async function loadRemoteAsset(
  url: string,
  cacheDir: string,
  fetchImpl: typeof fetch,
): Promise<Buffer> {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const ext = url.includes("mask") ? "mask.png" : url.endsWith(".json") ? "json" : "frame.png";
  const path = join(cacheDir, `${hash}-${ext}`);
  if (existsSync(path)) return readFileSync(path);

  mkdirSync(cacheDir, { recursive: true });
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`failed to download frame asset (${res.status}): ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(path, buf);
  return buf;
}

async function resolveRemoteScreen(
  preset: RemoteDevicePreset,
  cacheDir: string,
  fetchImpl: typeof fetch,
): Promise<{ screen: ScreenRect; frameSize: { width: number; height: number } }> {
  try {
    const tplBuf = await loadRemoteAsset(`${preset.assetBase}/template.json`, cacheDir, fetchImpl);
    const tpl = JSON.parse(tplBuf.toString("utf8")) as {
      screen?: ScreenRect;
      frameSize?: { width: number; height: number };
    };
    if (tpl.screen && tpl.frameSize) {
      return { screen: tpl.screen, frameSize: tpl.frameSize };
    }
  } catch {
    /* fall back to catalog geometry */
  }
  return { screen: preset.screen, frameSize: preset.frameSize };
}

async function compositeWithDeviceFrame(
  screenshot: Uint8Array,
  framePng: Buffer,
  maskPng: Buffer | null,
  screen: ScreenRect,
  frameSize: { width: number; height: number },
  fit: FrameFit,
): Promise<Buffer> {
  const fitted = await sharp(screenshot)
    .rotate()
    .resize(screen.width, screen.height, {
      fit,
      position: "centre",
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .ensureAlpha()
    .png()
    .toBuffer();

  // Full-canvas screenshot layer (transparent outside the screen rect).
  let screenLayer = await sharp({
    create: {
      width: frameSize.width,
      height: frameSize.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: fitted, left: screen.x, top: screen.y }])
    .png()
    .toBuffer();

  if (maskPng) {
    // mask: white = screen. dest-in keeps screenshot only where mask is opaque.
    screenLayer = await sharp(screenLayer)
      .composite([{ input: maskPng, blend: "dest-in" }])
      .png()
      .toBuffer();
  }

  return sharp({
    create: {
      width: frameSize.width,
      height: frameSize.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: screenLayer, left: 0, top: 0 },
      { input: framePng, left: 0, top: 0 },
    ])
    .png()
    .toBuffer();
}

async function proceduralPhone(screenshot: Uint8Array, fit: FrameFit): Promise<Buffer> {
  const screenW = 390;
  const screenH = 844;
  const bezel = 14;
  const topChrome = 36;
  const bottomChrome = 18;
  const outerW = screenW + bezel * 2;
  const outerH = screenH + topChrome + bottomChrome;
  const radius = 48;

  const fitted = await sharp(screenshot)
    .rotate()
    .resize(screenW, screenH, {
      fit,
      position: "centre",
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .png()
    .toBuffer();

  // Rounded-rect mask for the screen
  const maskSvg = Buffer.from(
    `<svg width="${screenW}" height="${screenH}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${screenW}" height="${screenH}" rx="36" ry="36" fill="white"/>
    </svg>`,
  );
  const roundedScreen = await sharp(fitted)
    .ensureAlpha()
    .composite([{ input: await sharp(maskSvg).png().toBuffer(), blend: "dest-in" }])
    .png()
    .toBuffer();

  const shellSvg = Buffer.from(
    `<svg width="${outerW}" height="${outerH}" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="${outerW - 2}" height="${outerH - 2}" rx="${radius}" ry="${radius}"
            fill="#1c1c1e" stroke="#3a3a3c" stroke-width="2"/>
      <rect x="${bezel + 70}" y="12" width="${screenW - 140}" height="22" rx="11" ry="11" fill="#0a0a0a"/>
      <circle cx="${outerW / 2}" cy="${outerH - 10}" r="4" fill="#3a3a3c"/>
    </svg>`,
  );

  return sharp(await sharp(shellSvg).png().toBuffer())
    .composite([{ input: roundedScreen, left: bezel, top: topChrome }])
    .png()
    .toBuffer();
}

async function proceduralBrowser(
  screenshot: Uint8Array,
  fit: FrameFit,
  url: string,
): Promise<Buffer> {
  const chromeH = 72;
  const pad = 12;
  const maxContentW = 1200;
  const maxContentH = 800;

  const meta = await sharp(screenshot).rotate().metadata();
  const srcW = meta.width ?? 800;
  const srcH = meta.height ?? 600;
  const scale = Math.min(1, maxContentW / srcW, maxContentH / srcH);
  const contentW = Math.max(320, Math.round(srcW * scale));
  const contentH = Math.max(200, Math.round(srcH * scale));
  const outerW = contentW + pad * 2;
  const outerH = contentH + chromeH + pad;

  const fitted = await sharp(screenshot)
    .rotate()
    .resize(contentW, contentH, {
      fit,
      position: "centre",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toBuffer();

  const safeUrl = escapeXml(url.slice(0, 80));
  const chromeSvg = Buffer.from(
    `<svg width="${outerW}" height="${outerH}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#f6f6f7"/>
          <stop offset="100%" stop-color="#e8e8ea"/>
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="${outerW - 1}" height="${outerH - 1}" rx="12" ry="12"
            fill="url(#g)" stroke="#c7c7cc" stroke-width="1"/>
      <circle cx="22" cy="22" r="6" fill="#ff5f57"/>
      <circle cx="42" cy="22" r="6" fill="#febc2e"/>
      <circle cx="62" cy="22" r="6" fill="#28c840"/>
      <rect x="84" y="12" width="${Math.max(120, outerW - 100)}" height="28" rx="8" ry="8"
            fill="#ffffff" stroke="#d1d1d6" stroke-width="1"/>
      <text x="96" y="31" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12"
            fill="#6e6e73">${safeUrl}</text>
      <rect x="${pad}" y="${chromeH}" width="${contentW}" height="${contentH}" fill="#ffffff"/>
    </svg>`,
  );

  return sharp(await sharp(chromeSvg).png().toBuffer())
    .composite([{ input: fitted, left: pad, top: chromeH }])
    .png()
    .toBuffer();
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function withPngExtension(filename: string): string {
  const base = filename.includes("/") ? filename.slice(filename.lastIndexOf("/") + 1) : filename;
  const dot = base.lastIndexOf(".");
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  return `${stem}.png`;
}

/**
 * Apply a named frame. Non-images pass through unchanged.
 * Output is PNG; callers typically run optimizeImageForUpload next.
 */
export async function applyFrame(
  bytes: Uint8Array,
  filename: string,
  opts: FrameOptions,
): Promise<FrameResult> {
  const id = opts.id.toLowerCase();
  const preset = FRAME_PRESETS[id];
  if (!preset) {
    throw new Error(`unknown frame "${opts.id}"`);
  }

  // Quick reject for obvious non-images (optimize will also skip).
  try {
    const meta = await sharp(bytes, { failOn: "none" }).metadata();
    if (!meta.format || meta.format === "svg") {
      return {
        bytes,
        filename,
        contentType: "application/octet-stream",
        framed: false,
        frameId: id,
        skippedReason: "not_image",
      };
    }
    if ((meta.pages ?? 1) > 1) {
      return {
        bytes,
        filename,
        contentType: meta.format === "gif" ? "image/gif" : "image/webp",
        framed: false,
        frameId: id,
        skippedReason: "animated",
      };
    }
  } catch {
    return {
      bytes,
      filename,
      contentType: "application/octet-stream",
      framed: false,
      frameId: id,
      skippedReason: "not_image",
    };
  }

  const fit: FrameFit = opts.fit ?? "cover";
  let out: Buffer;

  if (preset.kind === "procedural") {
    if (id === "browser") {
      out = await proceduralBrowser(bytes, fit, opts.browserUrl ?? "https://app.example");
    } else {
      out = await proceduralPhone(bytes, fit);
    }
  } else {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const cacheDir = opts.cacheDir ?? defaultCacheDir();
    const { screen, frameSize } = await resolveRemoteScreen(preset, cacheDir, fetchImpl);
    const framePng = await loadRemoteAsset(`${preset.assetBase}/frame.png`, cacheDir, fetchImpl);
    let maskPng: Buffer | null = null;
    try {
      maskPng = await loadRemoteAsset(`${preset.assetBase}/mask.png`, cacheDir, fetchImpl);
    } catch {
      maskPng = null;
    }
    // Downscale huge device frames so WebP optimize stays snappy.
    const maxEdge = 1600;
    const scale = Math.min(1, maxEdge / Math.max(frameSize.width, frameSize.height));
    const scaledScreen: ScreenRect = {
      x: Math.round(screen.x * scale),
      y: Math.round(screen.y * scale),
      width: Math.round(screen.width * scale),
      height: Math.round(screen.height * scale),
    };
    const scaledSize = {
      width: Math.round(frameSize.width * scale),
      height: Math.round(frameSize.height * scale),
    };
    const scaledFrame =
      scale < 1
        ? await sharp(framePng).resize(scaledSize.width, scaledSize.height).png().toBuffer()
        : framePng;
    const scaledMask =
      maskPng && scale < 1
        ? await sharp(maskPng).resize(scaledSize.width, scaledSize.height).png().toBuffer()
        : maskPng;

    out = await compositeWithDeviceFrame(
      bytes,
      scaledFrame,
      scaledMask,
      scaledScreen,
      scaledSize,
      fit,
    );
  }

  return {
    bytes: new Uint8Array(out),
    filename: withPngExtension(filename),
    contentType: "image/png",
    framed: true,
    frameId: id,
  };
}
