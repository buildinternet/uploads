import { createRoot } from "react-dom/client";
import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import { Tray } from "./tray";
import { scopeFrom, type TrayClient, type TrayEvent } from "./client";
import "./styles.css";

const app = new App({ name: "Uploads", version: "1.0.0" });
const listeners = new Set<(event: TrayEvent) => void>();
const emit = (event: TrayEvent) => {
  for (const listener of listeners) listener(event);
};
app.ontoolinput = ({ arguments: args }) => {
  const scope = scopeFrom(args);
  if (scope) emit({ type: "input", scope });
};
app.ontoolresult = (result) => emit({ type: "result", result });
function applyContext() {
  const context = app.getHostContext();
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.safeAreaInsets) {
    const { top, right, bottom, left } = context.safeAreaInsets;
    document.body.style.padding = `${top}px ${right}px ${bottom}px ${left}px`;
  }
}
app.onhostcontextchanged = applyContext;
const client: TrayClient = {
  async connect() {
    if (window.parent === window)
      throw new Error("Open Uploads from the conversation panel in your chat app.");
    await app.connect(undefined, { timeout: 15000 });
    applyContext();
  },
  async callTool(name, args) {
    if (
      document.documentElement.dataset.uploadsToolCatalog === "staged-v1" &&
      name !== "list_staged_media" &&
      name !== "list_staged_scopes"
    )
      throw new Error(
        "This chat uses an older Uploads connection. To view attached files, refresh Uploads tools in Plugins settings, then open Uploads in a new chat.",
      );
    return app.callServerTool({ name, arguments: args });
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
createRoot(document.getElementById("root")!).render(<Tray client={client} />);
