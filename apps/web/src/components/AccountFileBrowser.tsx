import { useFiles } from "files-sdk/react";
import { Button, Callout, FileBrowser } from "@uploads/ui";
import "@uploads/ui/styles.css";
import { useState } from "react";
import { filePath } from "../lib/public-file";
import { setFileVisibility } from "../lib/api-client";

interface Props {
  apiOrigin: string;
  workspace: string;
  /**
   * Whether this workspace has a stable public custom domain configured (from
   * `GET /me/workspaces`' `hasPublicUrl`). Workspaces without one (private/BYO
   * without a public domain) can't be opened via the public `/f/` page — it
   * 404s there (issue #123) — so those resolve through the authenticated,
   * signed-URL-capable `/me/.../file-url` endpoint instead.
   */
  hasPublicUrl: boolean;
  /** Folder prefix to open on mount (from `?path=`). */
  initialPrefix?: string;
  /** Fired on folder navigation for `?ws=&path=` URL sync. */
  onPrefixChange?: (prefix: string) => void;
}

const credentialedFetch: typeof fetch = async (input, init) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    return await fetch(input, {
      ...init,
      credentials: "include",
      signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

export function AccountFileBrowser({
  apiOrigin,
  workspace,
  hasPublicUrl,
  initialPrefix = "",
  onPrefixChange,
}: Props) {
  const files = useFiles({
    endpoint: `${apiOrigin.replace(/\/$/, "")}/me/workspaces/${encodeURIComponent(workspace)}/file-browser`,
    fetchImpl: credentialedFetch,
  });
  // Keys with an in-flight visibility PATCH, so the toggle button disables
  // itself per-row instead of blocking the whole list.
  const [togglingKeys, setTogglingKeys] = useState<ReadonlySet<string>>(new Set());
  const [toggleError, setToggleError] = useState<string | null>(null);

  const toggleVisibility = async (
    key: string,
    next: "public" | "private",
    onSuccess: () => void,
  ) => {
    setTogglingKeys((prev) => new Set(prev).add(key));
    setToggleError(null);
    try {
      const result = await setFileVisibility(apiOrigin, workspace, key, next);
      if (result.kind === "success") onSuccess();
      else setToggleError(`Couldn't make "${key}" ${next}. Try again shortly.`);
    } finally {
      setTogglingKeys((prev) => {
        const copy = new Set(prev);
        copy.delete(key);
        return copy;
      });
    }
  };

  // Public workspaces open the chrome-wrapped file page (issue #135) rather
  // than dumping the raw bytes into a tab — it presents metadata and links to
  // the original.
  const openPublicFile = (key: string) => {
    const tab = window.open(filePath(workspace, key), "_blank");
    if (tab) tab.opener = null;
  };

  // Private/BYO workspaces without a public domain have no `/f/` page to open
  // (it 404s — publicUrl() has nothing to resolve). Resolve through the
  // member-gated resolver instead, which signs a short-lived download URL when
  // the workspace's storage credentials support it (issue #123). Opens
  // "about:blank" synchronously so popup blockers see it as the row click,
  // then navigates that tab once the URL resolves — the same approach this
  // component used before the #135 public-page navigation replaced it here.
  const openResolvedFile = async (key: string) => {
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const response = await credentialedFetch(
        `${apiOrigin.replace(/\/$/, "")}/me/workspaces/${encodeURIComponent(workspace)}/file-url?key=${encodeURIComponent(key)}`,
      );
      const body = (await response.json().catch(() => ({}))) as { url?: string };
      if (!(response.ok && body.url)) throw new Error("file URL unavailable");
      if (tab) tab.location.replace(body.url);
      else window.location.assign(body.url);
    } catch {
      tab?.close();
    }
  };

  const openFile = (key: string) => {
    if (hasPublicUrl) {
      openPublicFile(key);
      return;
    }
    void openResolvedFile(key);
  };

  return (
    <>
      <div className="ws-section-head">Files</div>
      {toggleError && (
        <Callout tone="error" role="alert">
          {toggleError}
        </Callout>
      )}
      <FileBrowser
        files={files}
        initialPrefix={initialPrefix}
        onPrefixChange={onPrefixChange}
        onSelect={(file) => openFile(file.key)}
        isPrivate={(file) => file.metadata?.visibility === "private"}
        itemActions={(file, { patchItem }) => {
          const isPrivate = file.metadata?.visibility === "private";
          const next = isPrivate ? "public" : "private";
          const busy = togglingKeys.has(file.key);
          // On success, patch the one row in place (rather than refresh())
          // so "Load more" pagination survives the toggle.
          const applyLocally = () => {
            const metadata = { ...file.metadata };
            if (next === "private") metadata.visibility = "private";
            else delete metadata.visibility;
            patchItem(file.key, { metadata });
          };
          return (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void toggleVisibility(file.key, next, applyLocally)}
            >
              {busy ? "…" : isPrivate ? "Make public" : "Make private"}
            </Button>
          );
        }}
      />
    </>
  );
}
