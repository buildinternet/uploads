/**
 * One presentation rule for a media item, shared by the public live link
 * page (pages/c/[id].astro) and the signed-in MediaTile (components/
 * MediaTile.tsx): image thumbnail, video (with its poster when there is
 * one), a derived poster for PDFs and other files, a lock for withheld
 * items, a "removed" state, and an extension tile only as the last fallback.
 *
 * Classification: a `contentType` string (including "") decides through
 * the same MIME sets the public file page uses (`fileKind`). When the
 * caller has no content type (`null`/`undefined`, e.g. slice 1's
 * ThumbItem rows), the key's extension decides through the shared
 * `fileTypeClassFromKey`, the same rule the API's type filter uses.
 */
import { fileTypeClassFromKey } from "@uploads/comment-render/scope";
import { fileKind } from "./public-file";
import { leafName } from "./workspace-screenshots";

export interface MediaTileInput {
  key: string;
  status: string;
  embedUrl: string | null;
  url: string | null;
  contentType?: string | null;
  posterUrl?: string | null;
}

export type MediaTileView =
  | { mode: "image"; src: string; alt: string }
  | { mode: "video"; src: string; poster: string | null }
  | { mode: "poster"; src: string }
  | { mode: "locked" }
  | { mode: "missing" }
  | { mode: "ext"; label: string };

/** Short lowercase extension for a generic tile; "file" when there is none. */
export function mediaExtLabel(key: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(key);
  return match ? match[1].toLowerCase() : "file";
}

function mediaClass(item: MediaTileInput): "image" | "video" | "other" {
  if (typeof item.contentType === "string") {
    const kind = fileKind(item.contentType);
    return kind === "file" ? "other" : kind;
  }
  const cls = fileTypeClassFromKey(item.key);
  return cls === "screenshot" ? "image" : cls;
}

export function mediaTileView(item: MediaTileInput): MediaTileView {
  if (item.status === "missing") return { mode: "missing" };
  if (item.status === "withheld") return { mode: "locked" };
  const cls = mediaClass(item);
  const src = item.url ?? item.embedUrl;
  const poster = item.posterUrl ?? null;
  if (cls === "image") {
    return src ? { mode: "image", src, alt: leafName(item.key) } : { mode: "locked" };
  }
  if (cls === "video") return src ? { mode: "video", src, poster } : { mode: "locked" };
  if (poster) return { mode: "poster", src: poster };
  return { mode: "ext", label: mediaExtLabel(item.key) };
}
