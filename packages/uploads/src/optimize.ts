/**
 * Client-side still-image optimization for put/attach.
 *
 * Default path for GitHub embeds: re-encode PNG/JPEG (and similar) to WebP,
 * cap the long edge, keep the smaller of original vs optimized. Animated GIF,
 * SVG, video, and non-images are left unchanged.
 */
import sharp from "sharp";

/** Longest edge in pixels (screenshots beyond this rarely help PR review). */
export const DEFAULT_OPTIMIZE_MAX_EDGE = 2400;

/** WebP quality tuned for UI screenshots (text/chrome stay sharp enough). */
export const DEFAULT_OPTIMIZE_QUALITY = 85;

export type OptimizeOutputFormat = "webp" | "jpeg";

export interface OptimizeImageOptions {
  /** When false, returns the input unchanged. Default true. */
  enabled?: boolean;
  format?: OptimizeOutputFormat;
  maxEdge?: number;
  quality?: number;
}

export interface OptimizeImageResult {
  bytes: Uint8Array;
  filename: string;
  /** Suggested Content-Type for the body (API still sniffs magic bytes). */
  contentType: string;
  optimized: boolean;
  /** Why bytes were left as-is when optimized is false. */
  skippedReason?: string;
  originalBytes: number;
  outputBytes: number;
}

const IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "tif",
  "tiff",
  "avif",
  "heic",
  "heif",
]);

function extensionOf(name: string): string {
  const base = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Replace a trailing image-looking extension, or append when missing. */
export function withImageExtension(name: string, ext: string): string {
  const clean = ext.replace(/^\./, "").toLowerCase();
  const slash = name.lastIndexOf("/");
  const dir = slash >= 0 ? name.slice(0, slash + 1) : "";
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = base.lastIndexOf(".");
  if (dot >= 0 && IMAGE_EXT.has(base.slice(dot + 1).toLowerCase())) {
    return `${dir}${base.slice(0, dot)}.${clean}`;
  }
  return `${dir}${base}.${clean}`;
}

function contentTypeForFormat(format: OptimizeOutputFormat): string {
  return format === "jpeg" ? "image/jpeg" : "image/webp";
}

function looksLikeSvg(bytes: Uint8Array, filename: string): boolean {
  if (extensionOf(filename) === "svg") return true;
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.length, 256)))
    .trimStart()
    .toLowerCase();
  return head.startsWith("<?xml") || head.startsWith("<svg");
}

function passthrough(
  bytes: Uint8Array,
  filename: string,
  contentType: string,
  skippedReason: string,
): OptimizeImageResult {
  return {
    bytes,
    filename,
    contentType,
    optimized: false,
    skippedReason,
    originalBytes: bytes.byteLength,
    outputBytes: bytes.byteLength,
  };
}

/**
 * Optimize still images for public embeds. Safe to call on any payload:
 * non-images and unsupported types pass through.
 */
export async function optimizeImageForUpload(
  bytes: Uint8Array,
  filename: string,
  opts: OptimizeImageOptions = {},
): Promise<OptimizeImageResult> {
  const originalBytes = bytes.byteLength;
  if (opts.enabled === false) {
    return passthrough(bytes, filename, guessContentType(filename), "disabled");
  }
  if (originalBytes === 0) {
    return passthrough(bytes, filename, guessContentType(filename), "empty");
  }
  if (looksLikeSvg(bytes, filename)) {
    return passthrough(bytes, filename, "image/svg+xml", "svg");
  }

  const format: OptimizeOutputFormat = opts.format ?? "webp";
  const maxEdge = opts.maxEdge ?? DEFAULT_OPTIMIZE_MAX_EDGE;
  const quality = opts.quality ?? DEFAULT_OPTIMIZE_QUALITY;
  if (!Number.isFinite(maxEdge) || maxEdge < 1) {
    throw new Error(`optimize maxEdge must be a positive number (got ${maxEdge})`);
  }
  if (!Number.isFinite(quality) || quality < 1 || quality > 100) {
    throw new Error(`optimize quality must be 1–100 (got ${quality})`);
  }

  let image = sharp(bytes, { animated: true, failOn: "none" });
  let meta: Awaited<ReturnType<typeof image.metadata>>;
  try {
    meta = await image.metadata();
  } catch {
    return passthrough(bytes, filename, guessContentType(filename), "not_image");
  }

  if (!meta.format) {
    return passthrough(bytes, filename, guessContentType(filename), "not_image");
  }

  // Animated GIF/WebP: keep as-is (re-encoding often breaks or balloons size).
  if ((meta.pages ?? 1) > 1) {
    return passthrough(
      bytes,
      filename,
      meta.format === "gif" ? "image/gif" : guessContentType(filename),
      "animated",
    );
  }

  if (meta.format === "gif") {
    // Single-frame GIF can convert; multi-page already returned above.
  }

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width > 0 && height > 0) {
    const longEdge = Math.max(width, height);
    if (longEdge > maxEdge) {
      image = image.resize({
        width: width >= height ? maxEdge : undefined,
        height: height > width ? maxEdge : undefined,
        fit: "inside",
        withoutEnlargement: true,
      });
    }
  }

  // Apply EXIF orientation so stored pixels match what users saw.
  image = image.rotate();

  let encoded: Buffer;
  try {
    if (format === "jpeg") {
      encoded = await image.jpeg({ quality, mozjpeg: true }).toBuffer();
    } else {
      encoded = await image.webp({ quality, effort: 4 }).toBuffer();
    }
  } catch {
    return passthrough(bytes, filename, guessContentType(filename), "encode_failed");
  }

  if (encoded.byteLength >= originalBytes) {
    return passthrough(bytes, filename, guessContentType(filename), "not_smaller");
  }

  const outFilename = withImageExtension(filename, format === "jpeg" ? "jpg" : "webp");
  return {
    bytes: new Uint8Array(encoded),
    filename: outFilename,
    contentType: contentTypeForFormat(format),
    optimized: true,
    originalBytes,
    outputBytes: encoded.byteLength,
  };
}

function guessContentType(filename: string): string {
  switch (extensionOf(filename)) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

/** Rewrite an object key's trailing image extension to match optimized output. */
export function rewriteKeyExtension(key: string, filename: string): string {
  const ext = extensionOf(filename);
  if (!ext || !IMAGE_EXT.has(ext)) return key;
  return withImageExtension(key, ext);
}
