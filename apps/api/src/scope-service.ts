/**
 * Thumbnails for the Files views. D1-only: URLs and poster URLs come from the
 * active storage config and the `video.poster` / `pdf.poster` metadata flags,
 * with no R2 HEAD per tile. The signed-in audience never withholds, and a
 * missing object is not detected here, so `status` is always "available".
 */
import { fileTypeClassFromKey } from "@uploads/comment-render/scope";
import type { StorageConfig } from "@uploads/storage";
import { videoPresentation } from "./poster";
import type { ScopeItem } from "./pr-scope";
import type { ThumbItem } from "./scope-wire";
import { objectPublicUrls } from "./storage";

export function toThumbItem(env: Env, cfg: StorageConfig, item: ScopeItem): ThumbItem {
  const urls = objectPublicUrls(env, cfg, item.key);
  const isPdf = item.key.toLowerCase().endsWith(".pdf");
  const { posterUrl } = videoPresentation(
    env,
    cfg,
    item.key,
    item.metadata,
    isPdf ? "application/pdf" : undefined,
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
