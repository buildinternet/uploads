/**
 * Storage file-detail sheet: media preview, user `path`/`state`, then the
 * experimental AI labels block. Open-page stays a real link so cmd-click
 * still reaches `/f/`.
 */
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@uploads/ui/components/ui/sheet";
import { AiLabels, UserPrimaryChips } from "./AiLabels";
import { newTabLinkProps, type FileOpener } from "../lib/file-opener";
import { fileTypeLabel, leafName, pickThumbnail } from "../lib/workspace-file-row";
import { formatBytes } from "../lib/public-file";
import { thumbUrl } from "../lib/thumb-url";

/** Row shape the files table already has — kept local to avoid a cycle. */
export interface PreviewFile {
  key: string;
  url: string | null;
  embedUrl: string | null;
  size?: number;
  contentType?: string;
  metadata?: Record<string, string>;
  pageUrl?: string;
}

export function FilePreviewDrawer({
  file,
  opener,
  onClose,
}: {
  file: PreviewFile | null;
  opener: FileOpener;
  onClose: () => void;
}) {
  const name = file ? leafName(file.key) : "";
  const thumb = file ? pickThumbnail(file) : { kind: "none" as const };
  const href = file ? opener.href(file) : null;
  const type = file ? fileTypeLabel(file) : "";
  const size = file && typeof file.size === "number" ? `${formatBytes(file.size)} · ${type}` : type;

  return (
    <Sheet
      open={file !== null}
      onOpenChange={(open: boolean) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {file && (
          <>
            <SheetHeader>
              <SheetTitle className="font-mono text-[length:var(--text-meta)] break-all">
                {name}
              </SheetTitle>
              <SheetDescription className="font-mono text-[length:var(--text-micro)]">
                {size || file.key}
              </SheetDescription>
            </SheetHeader>
            <div className="grid gap-4 px-4 pb-2">
              <div className="overflow-hidden rounded-[var(--radius-lg,10px)] border border-line bg-bg">
                {thumb.kind === "image" ? (
                  <img
                    src={thumbUrl(thumb.src, 1120)}
                    alt=""
                    className="block max-h-[min(420px,50vh)] w-full object-contain"
                  />
                ) : (
                  <div className="grid aspect-[16/10] place-items-center text-[length:var(--text-micro)] tracking-[0.08em] text-muted-foreground uppercase">
                    {type || "file"}
                  </div>
                )}
              </div>
              <UserPrimaryChips metadata={file.metadata} />
              <AiLabels metadata={file.metadata} />
            </div>
            <SheetFooter>
              {href ? (
                <a
                  {...newTabLinkProps}
                  href={href}
                  className="text-[length:var(--text-micro)] text-muted-foreground no-underline hover:text-accent focus-visible:text-accent focus-visible:outline-none"
                >
                  Open page ↗
                </a>
              ) : (
                <button
                  type="button"
                  className="cursor-pointer border-0 bg-none p-0 text-left text-[length:var(--text-micro)] text-muted-foreground hover:text-accent focus-visible:text-accent focus-visible:outline-none"
                  onClick={() => opener.activate(file)}
                >
                  Open file ↗
                </button>
              )}
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
