/**
 * Signed-in media thumbnail drawn from `mediaTileView`. It follows the same
 * rules as the public live link page (pages/c/[id].astro), so the in-app
 * Files views and a shared link show an item the same way: image
 * thumbnails, video posters (or the first frame), PDF posters, and an
 * extension tile only as the last fallback. Visual only: the caller owns
 * the link or button around it and that element's accessible name.
 */
import { useState } from "react";
import { mediaExtLabel, mediaTileView, type MediaTileInput } from "../lib/media-tile";
import { thumbUrl } from "../lib/thumb-url";

export interface MediaTileProps {
  item: MediaTileInput;
  /** Transform width, about 2x the rendered CSS width (see thumbUrl). */
  width?: number;
  className?: string;
}

const FRAME =
  "relative grid aspect-[16/10] w-full place-items-center overflow-hidden rounded-[2px] bg-bg";
const MEDIA = "h-full w-full object-contain";
const TILE_TEXT = "font-mono text-(length:--text-micro) uppercase text-muted-foreground";

function PlayBadge() {
  return (
    <span
      className="absolute right-1.5 bottom-1.5 grid size-5 place-items-center rounded-full border border-line bg-panel text-fg"
      aria-hidden="true"
    >
      <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
        <path d="M1.5 0.8v6.4L7 4z" />
      </svg>
    </span>
  );
}

function LockGlyph() {
  return (
    <svg
      className="size-4 text-muted-foreground"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      <rect x="3.5" y="7.5" width="9" height="6" rx="1" />
      <path d="M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

export function MediaTile({ item, width = 560, className }: MediaTileProps) {
  // Keyed by item so a reused tile showing a different item starts unbroken.
  const [brokenKey, setBrokenKey] = useState<string | null>(null);
  const broken = brokenKey === item.key;
  const view = mediaTileView(item);
  const frame = className ? `${FRAME} ${className}` : FRAME;

  if (broken) {
    return (
      <span className={frame} aria-hidden="true">
        <span className={TILE_TEXT}>{mediaExtLabel(item.key)}</span>
      </span>
    );
  }

  switch (view.mode) {
    case "image":
      return (
        <span className={frame} aria-hidden="true">
          <img
            className={MEDIA}
            src={thumbUrl(view.src, width)}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setBrokenKey(item.key)}
          />
        </span>
      );
    case "video":
      return (
        <span className={frame} aria-hidden="true">
          {view.poster ? (
            <img
              className={MEDIA}
              src={thumbUrl(view.poster, width)}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setBrokenKey(item.key)}
            />
          ) : (
            <video
              className={MEDIA}
              src={view.src}
              preload="metadata"
              muted
              playsInline
              onError={() => setBrokenKey(item.key)}
            />
          )}
          <PlayBadge />
        </span>
      );
    case "poster":
      return (
        <span className={frame} aria-hidden="true">
          <img
            className={MEDIA}
            src={thumbUrl(view.src, width)}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setBrokenKey(item.key)}
          />
        </span>
      );
    case "locked":
      return (
        <span className={frame} aria-hidden="true">
          <LockGlyph />
        </span>
      );
    case "missing":
      return (
        <span className={frame} aria-hidden="true">
          <span className={TILE_TEXT}>removed</span>
        </span>
      );
    case "ext":
      return (
        <span className={frame} aria-hidden="true">
          <span className={TILE_TEXT}>{view.label}</span>
        </span>
      );
  }
}
