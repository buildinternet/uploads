/**
 * Hover preview for media tiles, moved from ScreenshotsByPath. Tiles call
 * `handlers.onPreviewEnter/Leave`; the caller renders `layer` once. Escape
 * and any scroll dismiss it. Placement is measured in a layout effect so the
 * corrected position lands before paint (shotPreviewPosition, #776).
 * `titles` (resolved on first hover) also feeds the tiles' PR labels.
 */
import { PrLabel } from "@uploads/ui/components/pr-label";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { getGithubTitles, type GithubTitleMap } from "../../lib/api-client";
import {
  lastUpdatedLabel,
  previewPrDisplay,
  shotPreviewPosition,
  type ShotPreviewBox,
} from "../../lib/workspace-screenshots";
import { GhKindIcon } from "./gh-glyphs";
import type { PreviewCaption, PreviewHandlers } from "./ShotThumb";

interface PreviewState {
  src: string;
  /** Trigger tile's viewport box, kept around so a re-measure (image load,
   * resolved title) can re-run `shotPreviewPosition` without re-reading a
   * DOM node that may have scrolled or unmounted. */
  thumb: ShotPreviewBox;
  left: number;
  top: number;
  name: string;
  pr?: string;
  kind?: string;
  ref?: string;
  uploadedAt?: string;
}

export function useShotPreview(
  apiOrigin: string,
  workspace: string,
): { handlers: PreviewHandlers; layer: ReactNode; titles: GithubTitleMap } {
  const previewTimer = useRef<number | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  // Live PR/issue status (open/closed/merged + title) keyed by `owner/repo#n`,
  // resolved lazily the first time a shot with that ref is hovered. A miss
  // stays recorded so a null/outage isn't re-fetched on every hover.
  const [titles, setTitles] = useState<GithubTitleMap>({});
  const titleFetches = useRef(new Set<string>());

  useEffect(() => {
    const dismiss = () => {
      if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
      previewTimer.current = null;
      setPreview(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("keydown", onKey);
    return () => {
      if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Flip-aware placement, measured rather than estimated: `shotPreviewPosition`
  // needs the pop-over's real box (the image's intrinsic aspect ratio and the
  // meta block's line count are both unknown before mount — a PR title can
  // add a line, an error state adds none), so this measures the ACTUAL
  // rendered element and only then decides which side/edge to place it on.
  // Runs in a layout effect, which lands the corrected position before the
  // browser paints — no visible jump — and re-runs whenever the full-size
  // image finishes loading or a resolved title changes the box's height.
  const previewRef = useRef<HTMLDivElement | null>(null);
  const positionPreview = () => {
    const el = previewRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPreview((prev) => {
      if (!prev) return prev;
      const pos = shotPreviewPosition(
        prev.thumb,
        { width: window.innerWidth, height: window.innerHeight },
        { width: rect.width, height: rect.height },
      );
      // Bail out to the same object when nothing moved — an unstable object
      // identity here would re-trigger this effect every render.
      if (pos.left === prev.left && pos.top === prev.top) return prev;
      return { ...prev, left: pos.left, top: pos.top };
    });
  };
  useLayoutEffect(positionPreview, [preview, titles]);

  const onPreviewLeave = () => {
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    previewTimer.current = null;
    setPreview(null);
  };
  // Resolve a ref's live PR/issue status once; the pop-over reads `titles`.
  const ensureTitle = (ref: string | undefined) => {
    if (!ref || ref in titles || titleFetches.current.has(ref)) return;
    titleFetches.current.add(ref);
    void getGithubTitles(apiOrigin, workspace, [ref]).then((map) => {
      const info = map?.[ref];
      if (info) setTitles((prev) => ({ ...prev, [ref]: info }));
    });
  };
  const onPreviewEnter = (
    el: HTMLElement,
    src: string,
    caption: PreviewCaption,
    opts?: { immediate?: boolean },
  ) => {
    // Keyboard focus (`opts.immediate`) opens regardless of hover capability
    // — `focusIsKeyboardDriven` at the call site already excludes touch taps.
    if (!opts?.immediate && !window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      return;
    }
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    // Prefetch the title now (not inside the timeout) so it's likely resolved
    // by the time the pop-over appears.
    ensureTitle(caption.ref);
    const open = () => {
      const rect = el.getBoundingClientRect();
      const thumb: ShotPreviewBox = {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      };
      setPreview({
        src,
        thumb,
        // Placeholder until the layout effect above measures the real box
        // and repositions before paint.
        left: thumb.right + 12,
        top: thumb.top,
        name: caption.name,
        pr: caption.pr,
        kind: caption.kind,
        ref: caption.ref,
        uploadedAt: caption.uploadedAt,
      });
    };
    if (opts?.immediate) {
      open();
      return;
    }
    const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 250;
    previewTimer.current = window.setTimeout(open, delay);
  };

  // A caption with a PR but no ref keeps its plain-text label instead of
  // dropping the line (previewPrDisplay).
  const previewPr = preview ? previewPrDisplay(preview, titles) : null;
  const layer = preview ? (
    <div
      className="wsp-preview"
      ref={previewRef}
      style={{ left: preview.left, top: preview.top }}
      role="presentation"
    >
      {/* onLoad: the real image height is only known once bytes arrive —
          re-clamp so a tall capture doesn't push the meta off-screen. */}
      <img src={preview.src} alt="" onLoad={positionPreview} />
      <div className="wsp-preview__meta">
        <div className="wsp-preview__name">{preview.name}</div>
        {previewPr && (
          <div className="wsp-preview__pr">
            <GhKindIcon kind={preview.kind} />{" "}
            {"label" in previewPr ? <PrLabel size="sm" {...previewPr.label} /> : previewPr.text}
          </div>
        )}
        {preview.uploadedAt && (
          <div className="wsp-preview__time">
            uploaded {lastUpdatedLabel(preview.uploadedAt, new Date())}
          </div>
        )}
      </div>
    </div>
  ) : null;

  return { handlers: { onPreviewEnter, onPreviewLeave }, layer, titles };
}
