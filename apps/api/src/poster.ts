/**
 * Video poster frames (issue #299).
 *
 * Design: `.context/2026-07-22-299-video-poster-thumbnails-design.md`.
 *
 * This module owns three things kept deliberately separate, mirroring
 * `render.ts`:
 *  - pure helpers (key layout, duration formatting, display width): no
 *    bindings, trivially unit-testable.
 *  - the `FrameExtractor` seam: wraps `env.MEDIA`. Media Transformations has
 *    no Miniflare/local simulation (it requires `"remote": true` and proxies
 *    to the real service), so the seam is required, not a nicety.
 *  - the `VideoProbe` seam: wraps Mediabunny's decoder-free demux path.
 */

import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import {
  ATTACHMENT_IMAGE_WIDTH_DEFAULT,
  ATTACHMENT_IMAGE_WIDTH_PORTRAIT,
  ATTACHMENT_IMAGE_WIDTH_WIDE,
  attachmentImageWidth,
} from "./github-comment-render";
import { allowPoster, VIDEO_TYPES } from "./guards";

/** Server-owned namespace for derived artifacts — never listed to users. */
export const POSTER_KEY_PREFIX = "_internal/posters/";

/**
 * Derived key for a video's poster. Appends `.jpg` to the *whole* key rather
 * than swapping the extension: collision-free (`clip.mp4` and `clip.webm`
 * stay distinct) and reversible.
 */
export function posterKeyFor(key: string): string {
  return `${POSTER_KEY_PREFIX}${key}.jpg`;
}

/** `m:ss` under an hour, `h:mm:ss` at or above one. */
export function formatDuration(seconds: number): string {
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, "0");
  if (h === 0) return `${m}:${ss}`;
  return `${h}:${String(m).padStart(2, "0")}:${ss}`;
}

export interface PosterDimensions {
  /** DISPLAY width — already rotation-corrected by the probe. */
  width: number;
  /** DISPLAY height — already rotation-corrected by the probe. */
  height: number;
}

/**
 * Display width for the poster `<img>` in a GitHub comment.
 *
 * Real dimensions only *select* among the existing width constants — a raw
 * 1920 would blow out the comment column. The result is additionally capped at
 * the real width so a small clip is never upscaled. With no dimensions, falls
 * back to the filename heuristic every image attachment already uses.
 *
 * Deliberately does NOT swap axes for rotation. The issue #299 spike measured
 * `env.MEDIA` returning an upright frame from a `rotation=-90` source, and
 * Mediabunny's `getDisplay*` are rotation-corrected by definition — applying
 * rotation here as well would double-correct and flip portrait to landscape.
 * Task 4's probe test pins that assumption against a real rotated fixture.
 */
export function posterImageWidth(dims: PosterDimensions | null, filename: string): number {
  if (!dims || dims.width <= 0 || dims.height <= 0) return attachmentImageWidth(filename);
  const chosen =
    dims.height > dims.width
      ? ATTACHMENT_IMAGE_WIDTH_PORTRAIT
      : dims.width / dims.height >= 16 / 9
        ? ATTACHMENT_IMAGE_WIDTH_WIDE
        : ATTACHMENT_IMAGE_WIDTH_DEFAULT;
  return Math.min(chosen, dims.width);
}

/** Transform width handed to Media Transformations. Valid range is 10–2000. */
export const POSTER_TRANSFORM_WIDTH = 640;

export interface FrameExtractor {
  frame(bytes: Uint8Array, opts: { time: string; width: number }): Promise<Uint8Array>;
}

/**
 * Wraps `env.MEDIA`. Builds a fresh stream per call because `input()` consumes
 * it — the caller retries at a different timestamp, which needs a second read.
 * Wraps `bytes` in a `ReadableStream` directly rather than via `new
 * Blob([bytes]).stream()`: Blob construction copies the buffer, and at up to
 * 100 MB per video (128 MB Worker memory cap) that copy matters.
 */
export function mediaFrameExtractor(media: MediaBinding): FrameExtractor {
  return {
    async frame(bytes, opts) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
      const result = media
        .input(stream)
        .transform({ width: opts.width, fit: "scale-down" })
        .output({ mode: "frame", time: opts.time, format: "jpg" });
      const response = await result.response();
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

export interface VideoProbeResult {
  durationSeconds: number | null;
  dimensions: PosterDimensions | null;
}

export interface VideoProbe {
  probe(bytes: Uint8Array): Promise<VideoProbeResult | null>;
}

/**
 * Container metadata via Mediabunny's demux path. Deliberately never touches
 * `canDecode`/`getDecoderConfig`/`*Sink` — those need WebCodecs, which the
 * Workers runtime does not provide. Everything read here is decoder-free.
 *
 * Returns null on anything unreadable: a probe failure must never prevent a
 * poster, only leave it without dimensions.
 */
export function mediabunnyProbe(): VideoProbe {
  return {
    async probe(bytes) {
      try {
        const input = new Input({
          source: new BufferSource(bytes),
          formats: ALL_FORMATS,
        });
        const track = await input.getPrimaryVideoTrack();
        if (!track) return null;
        const [durationSeconds, width, height] = await Promise.all([
          track.computeDuration(),
          // getDisplay* are rotation-corrected; getCoded* are not. Callers
          // treat these as final and never re-apply rotation.
          track.getDisplayWidth(),
          track.getDisplayHeight(),
        ]);
        return {
          durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
          dimensions: width > 0 && height > 0 ? { width, height } : null,
        };
      } catch {
        return null;
      }
    },
  };
}

/** Media Transformations input ceiling. */
export const POSTER_MAX_INPUT_BYTES = 100 * 1024 * 1024;
/** Media Transformations input duration ceiling. */
export const POSTER_MAX_DURATION_SECONDS = 600;
/**
 * Content types we attempt a transform for. The docs specify MP4/H.264, but
 * the issue #299 spike measured HEVC, QuickTime, and VP9/WebM all succeeding —
 * so this admits everything `guards.ts` accepts as video rather than mp4 only.
 */
export const POSTER_SOURCE_CONTENT_TYPES = VIDEO_TYPES;

export interface MadePoster {
  jpeg: Uint8Array;
  /** Reserved `video.*` metadata to write on the source object. */
  meta: Record<string, string>;
}

/**
 * Extract a poster frame, or return null. Every failure is silent by design:
 * no poster means the comment renderer falls back to a bullet link, which is
 * exactly today's behavior.
 */
export async function makePoster(
  input: { bytes: Uint8Array; contentType: string },
  deps: { extractor: FrameExtractor; probe: VideoProbe },
): Promise<MadePoster | null> {
  if (!POSTER_SOURCE_CONTENT_TYPES.has(input.contentType)) return null;
  if (input.bytes.byteLength > POSTER_MAX_INPUT_BYTES) return null;

  const probed = await deps.probe.probe(input.bytes);
  const dims = probed?.dimensions ?? null;

  // The probe doubles as the pre-flight gate: it is what knows the duration
  // before we attempt a transform the 10-minute ceiling would reject.
  if (probed?.durationSeconds != null && probed.durationSeconds > POSTER_MAX_DURATION_SECONDS) {
    return null;
  }

  // 1s first: first frames are often black. 0s covers clips shorter than that.
  let jpeg: Uint8Array | null = null;
  for (const time of ["1s", "0s"]) {
    try {
      jpeg = await deps.extractor.frame(input.bytes, {
        time,
        width: POSTER_TRANSFORM_WIDTH,
      });
      break;
    } catch {
      // Fall through to the next timestamp; both failing means no poster.
    }
  }
  if (!jpeg) return null;

  const meta: Record<string, string> = { "video.poster": "1" };
  if (probed?.durationSeconds != null) {
    meta["video.duration"] = String(Math.floor(probed.durationSeconds));
  }
  if (dims) {
    meta["video.width"] = String(dims.width);
    meta["video.height"] = String(dims.height);
  }
  return { jpeg, meta };
}

/** Flagship flag controlling poster generation globally. */
export const POSTER_FLAG = "video-poster-generation";

/**
 * Every kill switch, cheapest first. Ordering matters: local checks run before
 * the limiter so an opted-out workspace never spends a token.
 *
 * Flagship **fails closed** — the default handed to `getBooleanValue` is
 * `false`, and that default is what's returned when evaluation fails or the
 * flag is missing. A thrown evaluation error (network/config) is also caught
 * and treated as `false`. Losing posters degrades to today's bullet link and
 * harms nothing; failing open would risk the switch not taking effect during
 * exactly the incident it exists for.
 *
 * The rate limiter is the one exception to `allowPoster`'s own shared
 * behavior: `makeRateLimitGuard` fails *open* when its binding is absent, by
 * design, for the pre-existing WRITE_LIMITER/RENDER_LIMITER guards. Poster
 * generation does not inherit that laxness — a missing `POSTER_LIMITER`
 * binding is treated as a hard kill switch here, checked explicitly before
 * ever delegating to `allowPoster`.
 */
export async function posterGenerationAllowed(
  env: Env,
  ws: { videoPosterEnabled?: boolean },
  workspaceName: string,
): Promise<boolean> {
  if (!env.MEDIA) return false;
  if (ws.videoPosterEnabled === false) return false;
  // Typed as always-present, but a self-hoster may have deleted the binding
  // from wrangler.jsonc — absent means off, same as every other switch here.
  if (!env.FLAGS) return false;
  // Unlike allowPoster's own fail-open default for a missing binding (shared
  // with WRITE_LIMITER/RENDER_LIMITER), poster generation fails closed here.
  if (!env.POSTER_LIMITER) return false;
  try {
    if (!(await env.FLAGS.getBooleanValue(POSTER_FLAG, false))) return false;
  } catch {
    // Flagship evaluation errors fail closed, same as a missing binding or a
    // disabled flag.
    return false;
  }
  return await allowPoster(env, workspaceName);
}
