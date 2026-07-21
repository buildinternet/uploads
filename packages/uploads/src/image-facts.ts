/**
 * Canonical metadata promoted from an image's own EXIF, read *before* the
 * optimizer strips it from the bytes. `--keep-exif` is orthogonal: it governs
 * whether the uploaded bytes retain EXIF, not whether we promote these keys.
 *
 * Promotion is allowlist-only. Anything not named here is discarded, and the
 * denials (GPS, serials, personal names, free-form comments) are load-bearing:
 * promoted values render on the public /f/ page.
 *
 * Design: .context/2026-07-21-upload-metadata-vocabulary-design.md
 */
import exifReader from "exif-reader";
import sharp from "sharp";
import { isMetaValueSafe } from "./metadata.js";
import { formatViewport } from "./metadata-vocab.js";

/** Below this, the image is a 1:1 photo rather than a scaled screen capture. */
const SCREEN_CAPTURE_MIN_DENSITY = 72;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** EXIF's `YYYY:MM:DD HH:MM:SS` (or a parsed Date) → ISO 8601, zone-honest. */
function formatCaptured(raw: unknown, offset: string | undefined): string | undefined {
  let stamp: string | undefined;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    // exif-reader builds this Date from the EXIF wall-clock digits as if UTC,
    // so the ISO prefix reproduces those digits exactly.
    stamp = raw.toISOString().slice(0, 19);
  } else {
    const text = asString(raw);
    const match = text && /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(text);
    if (match) stamp = `${match[1]}-${match[2]}-${match[3]}T${match[4]}`;
  }
  if (!stamp) return undefined;
  // Only claim a zone when EXIF actually carried one. Never append a bare "Z".
  const zone = offset && /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : "";
  return `${stamp}${zone}`;
}

/** Combine Make + Model without repeating the make (`Canon` + `Canon EOS R5`). */
function formatDevice(make: string | undefined, model: string | undefined): string | undefined {
  if (!model) return make;
  if (!make) return model;
  return model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`;
}

/**
 * Map exif-reader's parsed tags onto canonical keys. Pure and total: junk
 * input yields `{}`. Only `device`, `software` and `captured` are ever read —
 * every other tag, including all of GPSInfo, is ignored by construction.
 */
export function factsFromExifTags(tags: unknown): Record<string, string> {
  const facts: Record<string, string> = {};
  if (!tags || typeof tags !== "object") return facts;

  const root = tags as Record<string, unknown>;
  const image = (root.Image ?? {}) as Record<string, unknown>;
  const photo = (root.Photo ?? {}) as Record<string, unknown>;

  const device = formatDevice(asString(image.Make), asString(image.Model));
  if (device) facts.device = device;

  const software = asString(image.Software);
  if (software) facts.software = software;

  const captured = formatCaptured(photo.DateTimeOriginal, asString(photo.OffsetTimeOriginal));
  if (captured) facts.captured = captured;

  // Derived values must satisfy the metadata contract or be dropped silently —
  // same posture as the existing best-effort gh.title.
  for (const [key, value] of Object.entries(facts)) {
    if (!isMetaValueSafe(value)) delete facts[key];
  }

  return facts;
}

/**
 * Read canonical facts from image bytes. Best-effort by contract: any failure
 * (not an image, corrupt EXIF, unsupported format) yields `{}` and must never
 * fail the upload.
 */
export async function imageFactsFromBytes(bytes: Uint8Array): Promise<Record<string, string>> {
  if (bytes.byteLength === 0) return {};

  let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    meta = await sharp(bytes, { failOn: "none" }).metadata();
  } catch {
    return {};
  }
  if (!meta.format) return {};

  const facts: Record<string, string> = {};

  // A density above 72dpi means a scaled screen capture: recover the logical
  // size the user actually saw. Camera photos report 72 and are skipped.
  const { width, height, density } = meta;
  if (width && height && density && density > SCREEN_CAPTURE_MIN_DENSITY) {
    const scale = density / SCREEN_CAPTURE_MIN_DENSITY;
    facts.viewport = formatViewport(width / scale, height / scale, scale);
  }

  if (meta.exif) {
    try {
      Object.assign(facts, factsFromExifTags(exifReader(meta.exif)));
    } catch {
      // Unparseable EXIF is not an error — keep whatever we already derived.
    }
  }

  return facts;
}
