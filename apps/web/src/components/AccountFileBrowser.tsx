import { useFiles } from "files-sdk/react";
import { FileBrowser } from "@uploads/ui";
import "@uploads/ui/styles.css";
import { filePath } from "../lib/public-file";

interface Props {
  apiOrigin: string;
  workspace: string;
}

const credentialedFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, credentials: "include" });

export function AccountFileBrowser({ apiOrigin, workspace }: Props) {
  const files = useFiles({
    endpoint: `${apiOrigin.replace(/\/$/, "")}/me/workspaces/${encodeURIComponent(workspace)}/file-browser`,
    fetchImpl: credentialedFetch,
  });

  // Open the chrome-wrapped file page (issue #135) rather than dumping the raw
  // bytes into a tab. The page presents metadata and links to the original; for
  // non-public workspaces it depends on the #123 URL resolver.
  const openFile = (key: string) => {
    const tab = window.open(filePath(workspace, key), "_blank");
    if (tab) tab.opener = null;
  };

  return (
    <>
      <div className="ws-section-head">Files</div>
      <FileBrowser files={files} onSelect={(file) => openFile(file.key)} />
    </>
  );
}
