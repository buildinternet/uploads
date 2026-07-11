/**
 * Optional device/browser frames for put/attach (default off).
 *
 * - `phone` / `browser` — procedural (no third-party assets)
 * - `iphone-16-pro` — fetches frame+mask from device-frames-media once,
 *   cached under ~/.cache/uploads/frames (not bundled in the npm package)
 *
 * @see https://github.com/jonnyjackson26/device-frames-media
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

export type FrameFit = "cover" | "contain";

export interface FrameOptions {
  id: string;
  fit?: FrameFit;
  /** Address bar text for procedural `browser`. */
  browserUrl?: string;
  fetchImpl?: typeof fetch;
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

type ScreenRect = { x: number; y: number; width: number; height: number };
type Size = { width: number; height: number };

type FramePreset =
  | { kind: "procedural"; label: string }
  | {
      kind: "remote";
      label: string;
      /** Directory URL with frame.png, mask.png, template.json */
      assetBase: string;
    };

const DEVICE_FRAMES_BASE =
  "https://raw.githubusercontent.com/jonnyjackson26/device-frames-media/main/device-frames-output";

export const FRAME_PRESETS: Record<string, FramePreset> = {
  phone: { kind: "procedural", label: "Generic phone bezel" },
  browser: { kind: "procedural", label: "Generic browser chrome" },
  "iphone-16-pro": {
    kind: "remote",
    label: "iPhone 16 Pro (community frame art)",
    assetBase: `${DEVICE_FRAMES_BASE}/Apple%20iPhone/16%20Pro/Black%20Titanium`,
  },
};

export function listFramePresets(): Array<{ id: string; label: string; kind: string }> {
  return Object.entries(FRAME_PRESETS).map(([id, p]) => ({
    id,
    label: p.label,
    kind: p.kind,
  }));
}

export function resolveFrameId(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const id = raw.trim().toLowerCase();
  if (!(id in FRAME_PRESETS)) {
    throw new Error(`unknown frame "${raw}" (known: ${Object.keys(FRAME_PRESETS).join(", ")})`);
  }
  return id;
}

function cacheDirDefault(): string {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "uploads", "frames");
}

async function cachedFetch(
  url: string,
  cacheDir: string,
  fetchImpl: typeof fetch,
): Promise<Buffer> {
  const name = `${createHash("sha256").update(url).digest("hex").slice(0, 16)}-${url.split("/").pop() ?? "bin"}`;
  const path = join(cacheDir, name);
  if (existsSync(path)) return readFileSync(path);
  mkdirSync(cacheDir, { recursive: true });
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`frame download failed (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(path, buf);
  return buf;
}

function scaleRect(r: ScreenRect, s: number): ScreenRect {
  return {
    x: Math.round(r.x * s),
    y: Math.round(r.y * s),
    width: Math.round(r.width * s),
    height: Math.round(r.height * s),
  };
}

async function compositeDevice(
  screenshot: Uint8Array,
  framePng: Buffer,
  maskPng: Buffer | undefined,
  screen: ScreenRect,
  frameSize: Size,
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

  let layer = await sharp({
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
    layer = await sharp(layer)
      .composite([{ input: maskPng, blend: "dest-in" }])
      .png()
      .toBuffer();
  }

  return sharp(layer)
    .composite([{ input: framePng, left: 0, top: 0 }])
    .png()
    .toBuffer();
}

async function proceduralPhone(screenshot: Uint8Array, fit: FrameFit): Promise<Buffer> {
  const screenW = 390;
  const screenH = 844;
  const bezel = 14;
  const top = 36;
  const bottom = 18;
  const outerW = screenW + bezel * 2;
  const outerH = screenH + top + bottom;

  const fitted = await sharp(screenshot)
    .rotate()
    .resize(screenW, screenH, {
      fit,
      position: "centre",
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .png()
    .toBuffer();

  const roundMask = await sharp(
    Buffer.from(
      `<svg width="${screenW}" height="${screenH}" xmlns="http://www.w3.org/2000/svg"><rect width="${screenW}" height="${screenH}" rx="36" fill="white"/></svg>`,
    ),
  )
    .png()
    .toBuffer();

  const screen = await sharp(fitted)
    .ensureAlpha()
    .composite([{ input: roundMask, blend: "dest-in" }])
    .png()
    .toBuffer();

  const shell = await sharp(
    Buffer.from(
      `<svg width="${outerW}" height="${outerH}" xmlns="http://www.w3.org/2000/svg">
        <rect x="1" y="1" width="${outerW - 2}" height="${outerH - 2}" rx="48" fill="#1c1c1e" stroke="#3a3a3c" stroke-width="2"/>
        <rect x="${bezel + 70}" y="12" width="${screenW - 140}" height="22" rx="11" fill="#0a0a0a"/>
        <circle cx="${outerW / 2}" cy="${outerH - 10}" r="4" fill="#3a3a3c"/>
      </svg>`,
    ),
  )
    .png()
    .toBuffer();

  return sharp(shell)
    .composite([{ input: screen, left: bezel, top }])
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
  const meta = await sharp(screenshot).rotate().metadata();
  const srcW = meta.width ?? 800;
  const srcH = meta.height ?? 600;
  const scale = Math.min(1, 1200 / srcW, 800 / srcH);
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

  const safe = url
    .slice(0, 80)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const chrome = await sharp(
    Buffer.from(
      `<svg width="${outerW}" height="${outerH}" xmlns="http://www.w3.org/2000/svg">
        <rect x="0.5" y="0.5" width="${outerW - 1}" height="${outerH - 1}" rx="12" fill="#f0f0f2" stroke="#c7c7cc"/>
        <circle cx="22" cy="22" r="6" fill="#ff5f57"/>
        <circle cx="42" cy="22" r="6" fill="#febc2e"/>
        <circle cx="62" cy="22" r="6" fill="#28c840"/>
        <rect x="84" y="12" width="${Math.max(120, outerW - 100)}" height="28" rx="8" fill="#fff" stroke="#d1d1d6"/>
        <text x="96" y="31" font-family="system-ui,sans-serif" font-size="12" fill="#6e6e73">${safe}</text>
        <rect x="${pad}" y="${chromeH}" width="${contentW}" height="${contentH}" fill="#fff"/>
      </svg>`,
    ),
  )
    .png()
    .toBuffer();

  return sharp(chrome)
    .composite([{ input: fitted, left: pad, top: chromeH }])
    .png()
    .toBuffer();
}

function asPngName(filename: string): string {
  const base = filename.includes("/") ? filename.slice(filename.lastIndexOf("/") + 1) : filename;
  const dot = base.lastIndexOf(".");
  return `${dot >= 0 ? base.slice(0, dot) : base}.png`;
}

function skip(
  bytes: Uint8Array,
  filename: string,
  frameId: string,
  reason: string,
  contentType = "application/octet-stream",
): FrameResult {
  return { bytes, filename, contentType, framed: false, frameId, skippedReason: reason };
}

/** Apply a named frame. Non-images pass through. Output PNG for the optimize step. */
export async function applyFrame(
  bytes: Uint8Array,
  filename: string,
  opts: FrameOptions,
): Promise<FrameResult> {
  const id = opts.id.toLowerCase();
  const preset = FRAME_PRESETS[id];
  if (!preset) throw new Error(`unknown frame "${opts.id}"`);

  try {
    const meta = await sharp(bytes, { failOn: "none" }).metadata();
    if (!meta.format || meta.format === "svg") return skip(bytes, filename, id, "not_image");
    if ((meta.pages ?? 1) > 1) {
      return skip(
        bytes,
        filename,
        id,
        "animated",
        meta.format === "gif" ? "image/gif" : "image/webp",
      );
    }
  } catch {
    return skip(bytes, filename, id, "not_image");
  }

  const fit: FrameFit = opts.fit ?? "cover";
  let out: Buffer;

  if (preset.kind === "procedural") {
    out =
      id === "browser"
        ? await proceduralBrowser(bytes, fit, opts.browserUrl ?? "https://app.example")
        : await proceduralPhone(bytes, fit);
  } else {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const cacheDir = opts.cacheDir ?? cacheDirDefault();
    const tpl = JSON.parse(
      (await cachedFetch(`${preset.assetBase}/template.json`, cacheDir, fetchImpl)).toString(
        "utf8",
      ),
    ) as { screen: ScreenRect; frameSize: Size };
    const framePng = await cachedFetch(`${preset.assetBase}/frame.png`, cacheDir, fetchImpl);
    let maskPng: Buffer | undefined;
    try {
      maskPng = await cachedFetch(`${preset.assetBase}/mask.png`, cacheDir, fetchImpl);
    } catch {
      /* optional */
    }

    // Keep remote frames light for PR embeds (display width is capped separately).
    const maxEdge = 1000;
    const s = Math.min(1, maxEdge / Math.max(tpl.frameSize.width, tpl.frameSize.height));
    const frameSize = {
      width: Math.round(tpl.frameSize.width * s),
      height: Math.round(tpl.frameSize.height * s),
    };
    const screen = scaleRect(tpl.screen, s);
    const frame =
      s < 1
        ? await sharp(framePng).resize(frameSize.width, frameSize.height).png().toBuffer()
        : framePng;
    const mask =
      maskPng && s < 1
        ? await sharp(maskPng).resize(frameSize.width, frameSize.height).png().toBuffer()
        : maskPng;

    out = await compositeDevice(bytes, frame, mask, screen, frameSize, fit);
  }

  return {
    bytes: new Uint8Array(out),
    filename: asPngName(filename),
    contentType: "image/png",
    framed: true,
    frameId: id,
  };
}
