/**
 * How a signed-in surface opens one of its files.
 *
 * Three destinations, in order: the API's own `pageUrl` (`/f/…` file page,
 * issue #308), else the same-origin `/f/` path when the workspace has a public
 * domain (issue #135), else a short-lived signed URL for private/BYO
 * workspaces (issue #123).
 *
 * The first two are known at render time, so callers render a real anchor and
 * get middle/cmd-click, hover preview, and no popup-blocker or blank-tab hop.
 * Only the third needs `activate`, which opens a blank tab synchronously (so
 * the blocker attributes it to the click) and redirects it once the URL lands.
 */
import { filePath } from "./public-file";
import { fetchWithTimeout } from "./request";

/** The subset of a file row these helpers need. */
export interface OpenableFile {
  key: string;
  pageUrl?: string;
}

export interface FileOpener {
  /** Destination when known at render time; null for private/BYO workspaces. */
  href(file: OpenableFile): string | null;
  /** Fallback open path — only meaningful when `href` returned null. */
  activate(file: OpenableFile): void;
}

async function resolveSignedFileUrl(
  apiOrigin: string,
  workspace: string,
  key: string,
): Promise<string | null> {
  const result = await fetchWithTimeout(
    `${apiOrigin.replace(/\/$/, "")}/v1/workspaces/${encodeURIComponent(workspace)}/files/file-url?key=${encodeURIComponent(key)}`,
    { credentials: "include", cache: "no-store" },
  );
  if (result.kind === "unavailable") return null;
  const body = (await result.response.json().catch(() => ({}))) as { url?: string };
  return result.response.ok && typeof body.url === "string" ? body.url : null;
}

export function fileHref(
  workspace: string,
  hasPublicUrl: boolean,
  file: OpenableFile,
): string | null {
  if (file.pageUrl) return file.pageUrl;
  return hasPublicUrl ? filePath(workspace, file.key) : null;
}

export function makeFileOpener(
  apiOrigin: string,
  workspace: string,
  hasPublicUrl: boolean,
): FileOpener {
  return {
    href: (file) => fileHref(workspace, hasPublicUrl, file),
    activate: (file) => {
      const tab = window.open("about:blank", "_blank");
      if (tab) tab.opener = null;
      void resolveSignedFileUrl(apiOrigin, workspace, file.key).then((url) => {
        if (url) {
          if (tab) tab.location.replace(url);
          else window.location.assign(url);
        } else {
          tab?.close();
        }
      });
    },
  };
}

/** Props that turn an element into a new-tab link to `href`. */
export const newTabLinkProps = { target: "_blank", rel: "noopener noreferrer" } as const;
