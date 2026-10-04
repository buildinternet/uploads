/**
 * Thumbnails for the Files views. D1-only: URLs and poster URLs come from the
 * active storage config and the `video.poster` / `pdf.poster` metadata flags,
 * with no R2 HEAD per tile. The signed-in audience never withholds, and a
 * missing object is not detected here, so `status` is always "available".
 */
import { fileTypeClassFromKey } from "@uploads/comment-render/scope";
import type { StorageConfig } from "@uploads/storage";
import { contentTypeFromKey } from "./guards";
import { videoPresentation } from "./poster";
import type { ScopeItem } from "./pr-scope";
import type { ThumbItem } from "./scope-wire";
import { objectPublicUrls } from "./storage";

/** The only metadata `toThumbItem` reads: the poster flags. */
export const THUMB_META_KEYS = ["video.poster", "pdf.poster"];

export function toThumbItem(env: Env, cfg: StorageConfig, item: ScopeItem): ThumbItem {
  const urls = objectPublicUrls(env, cfg, item.key);
  const { posterUrl } = videoPresentation(
    env,
    cfg,
    item.key,
    item.metadata,
    contentTypeFromKey(item.key),
  );
  return {
    key: item.key,
    kind: fileTypeClassFromKey(item.key),
    url: urls.url,
    embedUrl: urls.embedUrl,
    posterUrl: posterUrl ?? null,
    status: "available",
  };
}
