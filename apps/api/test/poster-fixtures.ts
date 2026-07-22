import { FakeMedia } from "./fake-media";
import { FakeR2Bucket } from "./fake-r2";
import { UsageFakeD1 } from "./usage-fake-d1";
import type { WorkspaceRecord } from "../src/workspace";

/**
 * Shared fixtures for poster-upload.test.ts, poster-lifecycle.test.ts, and
 * poster-listing.test.ts (issue #299) — same MP4/PNG bytes and the same
 * MEDIA/FLAGS/POSTER_LIMITER env shape `posterGenerationAllowed` gates on
 * (mirrors poster-gate.test.ts's `env()` helper for that shape).
 */

// ftyp box → sniffs as video/mp4 (see guards.test.ts's identical helper).
function ftyp(brand: string): Uint8Array {
  return new Uint8Array([
    0,
    0,
    0,
    0x18,
    0x66,
    0x74,
    0x79,
    0x70,
    ...[...brand].map((ch) => ch.charCodeAt(0)),
  ]);
}

export const MP4 = ftyp("mp42");
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
export const WORKSPACE = "default";

/**
 * `UsageFakeD1` (test/usage-fake-d1.ts) backs a real workspace_usage ledger
 * AND file_metadata — unlike routes-files.test.ts's makeFakeDB, which no-ops
 * the ledger — so it's the right fixture whenever a test needs to read
 * either back out. Mirrors routes-files-usage-resilience.test.ts's `makeEnv`,
 * plus the MEDIA/FLAGS/POSTER_LIMITER bindings `posterGenerationAllowed`
 * gates on (see poster-gate.test.ts's `env()` helper for that shape).
 */
export function makePosterEnv(posterJpeg: Uint8Array = new Uint8Array([1, 2, 3])) {
  const bucket = new FakeR2Bucket();
  const db = new UsageFakeD1();
  const env = {
    DB: db,
    UPLOADS_DEFAULT: bucket,
    MEDIA: FakeMedia.jpeg(posterJpeg),
    FLAGS: { getBooleanValue: async () => true },
    POSTER_LIMITER: { limit: async () => ({ success: true }) },
  } as unknown as Env;
  const ws: WorkspaceRecord = {
    provider: "r2",
    bucket: "uploads-default",
    binding: "UPLOADS_DEFAULT",
    prefix: "default/",
    publicBaseUrl: "https://storage.uploads.sh",
  };
  return { env, bucket, db, ws };
}
