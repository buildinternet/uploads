/**
 * One media tile for the Files views and the By page strips. Images keep
 * the strip's resized thumbnail and intrinsic aspect ratio; videos and PDF
 * posters render through MediaTile (same rules as the public live
 * link page, including its play badge); withheld files show a lock, removed
 * ones say so, and anything else shows its extension. Renders as an <a> when
 * the destination is known at render time and a <button> only for the
 * private/BYO signed-URL fallback.
 */
import { useState, type ReactNode } from "react";
import { MediaTile } from "../MediaTile";
import { newTabLinkProps } from "../../lib/file-opener";
import { mediaExtLabel, mediaTileView } from "../../lib/media-tile";
import { thumbUrl } from "../../lib/thumb-url";
import {
  focusIsKeyboardDriven,
  leafName,
  shotPreviewCaption,
  shotTileInput,
  type ShotPreviewCaption,
} from "../../lib/workspace-screenshots";

export interface ShotThumbItem {
  key: string;
  url: string | null;
  embedUrl: string | null;
  state?: string;
  ghKind?: string;
  ghNumber?: string;
  ghRef?: string;
  updatedAt?: string;
  uploadedAt?: string;
  metadata?: Record<string, string>;
  /** Scope/feed DTOs carry these; by-path items do not. */
  status?: string;
  contentType?: string | null;
  posterUrl?: string | null;
}

export type PreviewCaption = ShotPreviewCaption & {
  /** GitHub kind, for the plain-text PR fallback's glyph. */
  kind?: string;
};

export type PreviewHandlers = {
  onPreviewEnter: (
    el: HTMLElement,
    caption: PreviewCaption,
    opts?: { immediate?: boolean },
  ) => void;
  onPreviewLeave: () => void;
};

/** Strip thumbs size from the image's intrinsic ratio (cached + onLoad). */
function applyShotThumbAspect(img: HTMLImageElement | null) {
  if (!img?.naturalWidth || !img.naturalHeight) return;
  img.parentElement?.style.setProperty("--wsp-ar", `${img.naturalWidth} / ${img.naturalHeight}`);
}

export function ShotThumb({
  item,
  paired,
  href,
  onOpen,
  onPreviewEnter,
  onPreviewLeave,
}: {
  item: ShotThumbItem;
  /** True when a before/after counterpart sits in the same strip/grid. */
  paired?: boolean;
  /** Known destination; when null the tile falls back to a button + `onOpen`. */
  href: string | null;
  onOpen: () => void;
  onPreviewEnter?: PreviewHandlers["onPreviewEnter"];
  onPreviewLeave?: () => void;
}) {
  const name = leafName(item.key);
  const tileInput = shotTileInput(item);
  const view = mediaTileView(tileInput);
  const [broken, setBroken] = useState(false);
  const imageSrc = view.mode === "image" && !broken ? view.src : null;
  // State stays in the accessible name, not a native `title` tooltip — that
  // tooltip sat on top of the hover preview.
  const stateSuffix = item.state ? ` (${item.state})` : "";
  const ghKindValue = item.ghKind ?? item.metadata?.["gh.kind"];
  const base = shotPreviewCaption(item);
  const caption: PreviewCaption = base.pr ? { ...base, kind: ghKindValue } : base;

  const shared = {
    className: "wsp-tile",
    "aria-label": `Open ${name}${stateSuffix}${caption.pr ? ` — ${caption.pr}` : ""}${caption.author ? ` by ${caption.author}` : ""}${paired ? " — has before/after pair" : ""}`,
    onMouseEnter: (event: { currentTarget: HTMLElement }) => {
      onPreviewEnter?.(event.currentTarget, caption);
    },
    onMouseLeave: () => onPreviewLeave?.(),
    // Keyboard-focus parity for the hover preview: `:focus-visible` gates
    // this to genuine keyboard navigation, so tapping a tile on a touch
    // device (which also focuses it) never opens a preview it can't hover
    // away from. Escape (handled in useShotPreview) dismisses it either way,
    // and dismissal never moves focus, so tab order is untouched.
    onFocus: (event: { currentTarget: HTMLElement }) => {
      if (focusIsKeyboardDriven(event.currentTarget)) {
        onPreviewEnter?.(event.currentTarget, caption, { immediate: true });
      }
    },
    onBlur: () => onPreviewLeave?.(),
  };

  let media: ReactNode;
  if (imageSrc) {
    media = (
      <span className="wsp-thumb" aria-hidden="true">
        <img
          src={thumbUrl(imageSrc, 560)}
          alt=""
          loading="lazy"
          decoding="async"
          ref={applyShotThumbAspect}
          onLoad={(event) => applyShotThumbAspect(event.currentTarget)}
          onError={() => setBroken(true)}
        />
      </span>
    );
  } else if (view.mode === "video" || view.mode === "poster") {
    media = (
      <span className="wsp-thumb wsp-thumb--media" aria-hidden="true">
        <MediaTile item={tileInput} />
      </span>
    );
  } else {
    // image (broken), locked, missing, or ext
    let label = mediaExtLabel(item.key);
    if (view.mode === "locked") label = "🔒";
    else if (view.mode === "missing") label = "removed";
    else if (view.mode === "ext") label = view.label;
    media = (
      <span className="wsp-thumb wsp-thumb--tile" aria-hidden="true">
        {label}
      </span>
    );
  }

  const body = (
    <>
      {media}
      {paired && (
        <span
          className="wsp-pair absolute top-1 right-1 grid h-[18px] w-[18px] place-items-center rounded-[4px] border border-line bg-panel text-muted-foreground"
          aria-hidden="true"
          title="Has a before/after pair"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="block">
            <rect x="1" y="1" width="4.5" height="10" rx="1" fill="currentColor" opacity="0.45" />
            <rect
              x="6.5"
              y="1"
              width="4.5"
              height="10"
              rx="1"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
        </span>
      )}
    </>
  );

  return href ? (
    <a {...shared} {...newTabLinkProps} href={href}>
      {body}
    </a>
  ) : (
    <button {...shared} type="button" onClick={onOpen}>
      {body}
    </button>
  );
}
