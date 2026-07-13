import { useFiles } from "files-sdk/react";
import { FileBrowser } from "@uploads/ui";
import "@uploads/ui/styles.css";

interface Props {
  apiOrigin: string;
  workspace: string;
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

export function AccountFileBrowser({ apiOrigin, workspace }: Props) {
  const files = useFiles({
    endpoint: `${apiOrigin.replace(/\/$/, "")}/me/workspaces/${encodeURIComponent(workspace)}/file-browser`,
    fetchImpl: credentialedFetch,
  });

  const openFile = async (key: string) => {
    // Open synchronously so popup blockers recognize this as the row click;
    // resolve the files-sdk URL into that tab afterward.
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const response = await credentialedFetch(
        `${apiOrigin.replace(/\/$/, "")}/me/workspaces/${encodeURIComponent(workspace)}/file-url?key=${encodeURIComponent(key)}`,
      );
      const body = (await response.json()) as { url?: string };
      if (!(response.ok && body.url)) throw new Error("file URL unavailable");
      if (tab) tab.location.replace(body.url);
      else window.location.assign(body.url);
    } catch {
      tab?.close();
    }
  };

  return (
    <>
      <div className="ws-section-head">Files</div>
      <FileBrowser files={files} onSelect={(file) => void openFile(file.key)} />
    </>
  );
}
