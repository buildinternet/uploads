import { createRoot } from "react-dom/client";
import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import { Tray } from "./tray";
import { scopeFrom, type TrayClient, type TrayEvent } from "./client";
import "./styles.css";

const app = new App({ name: "Uploads staged media", version: "1.0.0" });
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
      throw new Error("Open Staged media from the Uploads plugin in your chat app.");
    await app.connect(undefined, { timeout: 15000 });
    applyContext();
  },
  callTool: (name, args) => app.callServerTool({ name, arguments: args }),
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
createRoot(document.getElementById("root")!).render(<Tray client={client} />);
