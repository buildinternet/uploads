import type { ThumbItem } from "../../lib/api-client";
import type { FileOpener } from "../../lib/file-opener";
import { thumbToTile } from "../../lib/files-scope";
import { ShotThumb, type PreviewHandlers } from "./ShotThumb";

/** A PR or repo row's recent thumbnails. Renders nothing when there are none. */
export function ThumbStrip({
  thumbnails,
  opener,
  preview,
}: {
  thumbnails: ThumbItem[];
  opener: FileOpener;
  preview: PreviewHandlers;
}) {
  if (thumbnails.length === 0) return null;
  return (
    <div className="wsp-strip">
      {thumbnails.map((thumb) => {
        const tile = thumbToTile(thumb);
        return (
          <ShotThumb
            key={tile.key}
            item={tile}
            href={opener.href(tile)}
            onOpen={() => opener.activate(tile)}
            {...preview}
          />
        );
      })}
    </div>
  );
}
