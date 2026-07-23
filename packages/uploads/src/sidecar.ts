/**
 * Sidecar manifest for `uploads screenshot --out`: derived metadata written
 * next to a local screenshot file so a later `put`/`attach` of that exact
 * file can recover the metadata the hosted copy would have gotten at capture
 * time. See issue #469 lever 2 (the "sidecar manifest" variant — the
 * alternative, content-hash-keyed server-side inheritance, is out of scope
 * here).
 *
 * File: `<file>.uploads.json` next to `<file>`, e.g. `shot.png.uploads.json`.
 * Shape: `{ version, sha256, meta }`. `sha256` is the SHA-256 of the exact
 * bytes written to `<file>` at capture time — read-back compares it against
 * the file's *current* bytes, so a file that was regenerated or hand-edited
 * since capture silently loses its sidecar instead of attaching stale
 * metadata to a different image.
 *
 * `meta` is filtered to the closed `CANONICAL_META_KEYS` vocabulary
 * (metadata-vocab.ts) on both write and read: the sidecar is a plain JSON
 * file sitting next to the image, so it must never be a channel for
 * arbitrary metadata even if hand-edited.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CANONICAL_META_KEYS, mergeDerivedMeta } from "./metadata-vocab.js";

const SIDECAR_VERSION = 1;

interface SidecarManifest {
  version: number;
  sha256: string;
  meta: Record<string, string>;
}

/** The sidecar path for a given local file — `<file>.uploads.json`. */
export function sidecarPath(filePath: string): string {
  return `${filePath}.uploads.json`;
}

/** Hex-encoded SHA-256 of `bytes`. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Keep only entries whose key is in the closed canonical metadata vocabulary. */
export function restrictToCanonicalMeta(meta: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of CANONICAL_META_KEYS) {
    if (Object.prototype.hasOwnProperty.call(meta, key)) out[key] = meta[key]!;
  }
  return out;
}

function isPlainStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === "string");
}

/**
 * Write a sidecar manifest next to `filePath`, recording `meta` (restricted
 * to the canonical vocabulary) and the SHA-256 of `bytes` (the exact bytes
 * being written to `filePath`). No-ops when `meta` is empty — an image with
 * no derived metadata gets no sidecar. Best-effort: a write failure (e.g. a
 * read-only directory) is swallowed, matching the rest of the derived-
 * metadata pipeline's "never fail the primary operation" contract.
 */
export function writeSidecarMeta(
  filePath: string,
  bytes: Uint8Array,
  meta: Record<string, string>,
): void {
  const restricted = restrictToCanonicalMeta(meta);
  if (Object.keys(restricted).length === 0) return;
  try {
    const manifest: SidecarManifest = {
      version: SIDECAR_VERSION,
      sha256: sha256Hex(bytes),
      meta: restricted,
    };
    writeFileSync(sidecarPath(filePath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch {
    // best-effort — never fail the screenshot over a sidecar write
  }
}

/**
 * Read back a sidecar manifest for `filePath`, only when it is present,
 * well-formed, and its recorded hash matches `bytes` (the file's current
 * content, as read for the upload in progress). Returns `undefined` on any
 * absence, parse failure, malformed shape, or hash mismatch — a sidecar is a
 * best-effort convenience and must never fail or noise an upload. Returned
 * keys are always a subset of `CANONICAL_META_KEYS`, so a hand-edited
 * manifest can never inject arbitrary metadata.
 */
export function readSidecarMeta(
  filePath: string,
  bytes: Uint8Array,
): Record<string, string> | undefined {
  const path = sidecarPath(filePath);
  try {
    if (!existsSync(path)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const candidate = parsed as { version?: unknown; sha256?: unknown; meta?: unknown };
    if (
      candidate.version !== SIDECAR_VERSION ||
      typeof candidate.sha256 !== "string" ||
      !isPlainStringRecord(candidate.meta)
    ) {
      return undefined;
    }
    if (candidate.sha256 !== sha256Hex(bytes)) return undefined; // stale/regenerated file
    const restricted = restrictToCanonicalMeta(candidate.meta);
    return Object.keys(restricted).length > 0 ? restricted : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merge `filePath`'s sidecar metadata (if any, per {@link readSidecarMeta})
 * under `baseMeta` — explicit metadata always wins. Shared by the `put` and
 * `attach` upload loops (issue #469 lever 2).
 */
export function mergeSidecarMeta(
  filePath: string,
  bytes: Uint8Array,
  baseMeta: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const sidecarMeta = readSidecarMeta(filePath, bytes);
  return sidecarMeta ? mergeDerivedMeta(baseMeta ?? {}, sidecarMeta) : baseMeta;
}
