import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import "./style.css";

const element = (id) => document.getElementById(id);
const app = new App({ name: "Uploads staged media compatibility spike", version: "0.0.0" });
let connected = false;
let resultCount = 0;
let requestSequence = 0;

// These images are authored fixtures, never URLs supplied by a tool result.
function picture(after) {
  const color = after ? "#8a5ac2" : "#606a7a";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420"><rect width="640" height="420" fill="${after ? "#f6f2fc" : "#eef0f4"}"/><rect x="24" y="24" width="592" height="372" rx="14" fill="white"/><rect x="24" y="24" width="148" height="372" rx="14" fill="${after ? "#30243d" : "#29313e"}"/><text x="46" y="64" font-family="Arial" font-size="17" fill="white">Studio</text><rect x="40" y="95" width="115" height="31" rx="5" fill="${color}"/><text x="49" y="116" font-family="Arial" font-size="12" fill="white">Settings</text><text x="197" y="66" font-family="Arial" font-size="23" font-weight="bold" fill="#28232d">Workspace settings</text><text x="198" y="93" font-family="Arial" font-size="12" fill="#777">${after ? "Make room for your best work." : "Manage your workspace."}</text><text x="198" y="138" font-family="Arial" font-size="12" fill="#555">Workspace name</text><rect x="197" y="151" width="385" height="39" rx="${after ? 8 : 2}" fill="#f7f6f8" stroke="#e3dfe8"/><text x="211" y="175" font-family="Arial" font-size="13" fill="#444">Design team</text><text x="198" y="225" font-family="Arial" font-size="12" fill="#555">Notifications</text><rect x="197" y="241" width="385" height="57" rx="8" fill="${after ? "#f7f1ff" : "#f6f6f7"}"/><text x="211" y="275" font-family="Arial" font-size="13" fill="#444">Weekly project updates</text><rect x="528" y="259" width="37" height="20" rx="10" fill="${color}"/><circle cx="554" cy="269" r="7" fill="white"/><rect x="${after ? 454 : 197}" y="326" width="128" height="37" rx="${after ? 9 : 2}" fill="${color}"/><text x="${after ? 474 : 217}" y="350" font-family="Arial" font-size="12" fill="white">Save changes</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
const pictures = { before: picture(false), after: picture(true) };

function showError(message) {
  element("gallery").replaceChildren();
  element("status").textContent = message;
  element("status").className = "error";
  element("count").textContent = "—";
}

function render(result) {
  element("results").textContent = String(++resultCount);
  if (result.isError) {
    showError(
      result.content?.find((item) => item.type === "text")?.text ||
        "The fixture could not be loaded.",
    );
    return;
  }
  const data = result.structuredContent;
  if (
    !data ||
    data.demo !== true ||
    !Array.isArray(data.files) ||
    data.files.some((file) => !Object.hasOwn(pictures, file.id))
  ) {
    showError("Unexpected fixture response. This spike only accepts its bundled demo images.");
    return;
  }
  element("scope").textContent = `${data.workspace} / ${data.repo} / ${data.branch}`;
  element("count").textContent = String(data.files.length);
  element("scenario").value = data.scenario;
  element("status").className = "";
  element("status").textContent = data.files.length
    ? "Before and after · /settings"
    : "No staged media in this demo. Choose Populated to see the comparison.";
  element("gallery").replaceChildren(
    ...data.files.map((file) => {
      const card = document.createElement("article");
      const image = document.createElement("img");
      image.src = pictures[file.id];
      image.alt = `Synthetic workspace settings screenshot, ${file.state}`;
      const caption = document.createElement("div");
      caption.className = "caption";
      const label = document.createElement("strong");
      label.textContent = file.state === "before" ? "Before" : "After";
      const name = document.createElement("span");
      name.textContent = file.filename;
      caption.append(label, name);
      card.append(image, caption);
      return card;
    }),
  );
}

function hostContext(ctx = {}) {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.safeAreaInsets) {
    const { top, right, bottom, left } = ctx.safeAreaInsets;
    document.body.style.padding = `${top}px ${right}px ${bottom}px ${left}px`;
  }
  element("mode").textContent = ctx.displayMode || "Not reported";
}

async function refresh() {
  if (!connected) return;
  const sequence = ++requestSequence;
  element("refresh").disabled = true;
  element("status").className = "";
  element("status").textContent = "Loading fixture through the host bridge…";
  try {
    const result = await app.callServerTool({
      name: "show_staged_media_demo",
      arguments: { scenario: element("scenario").value },
    });
    if (sequence === requestSequence) render(result);
  } catch (error) {
    if (sequence === requestSequence) showError(`Bridge tool call failed: ${error.message}`);
  } finally {
    if (sequence === requestSequence) element("refresh").disabled = false;
  }
}

app.ontoolinput = () => {
  element("status").textContent = "Loading fixture…";
};
app.ontoolresult = render;
app.onhostcontextchanged = () => hostContext(app.getHostContext());
app.onteardown = async () => {
  connected = false;
  requestSequence++;
  return {};
};
element("refresh").addEventListener("click", () => {
  void refresh();
});
element("scenario").addEventListener("change", () => {
  void refresh();
});

if (window.parent === window) {
  element("bridge").textContent = "No host (standalone page)";
  showError("Open this resource through an MCP Apps host. The local harness is available at /.");
} else {
  try {
    await app.connect(undefined, { timeout: 15000 });
    connected = true;
    const host = app.getHostVersion();
    element("bridge").textContent = "Connected";
    element("host").textContent = host ? `${host.name} ${host.version}` : "Not reported";
    element("refresh").disabled = false;
    hostContext(app.getHostContext());
    // Global/thread entrypoints can open before any conversational tool result exists.
    if (!resultCount) await refresh();
  } catch (error) {
    element("bridge").textContent = "Connection failed";
    showError(`MCP Apps initialization failed: ${error.message}`);
  }
}
