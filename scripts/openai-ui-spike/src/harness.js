import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const status = document.getElementById("harness-status");
const iframe = document.getElementById("app");
const client = new Client({ name: "uploads-local-sdk-harness", version: "0.0.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", window.location.href)));
  const { tools } = await client.listTools();
  const tool = tools.find((candidate) => candidate.name === "show_staged_media_demo");
  const resource = await client.readResource({ uri: tool._meta.ui.resourceUri });
  let context = {
    theme: "light",
    displayMode: "inline",
    availableDisplayModes: ["inline"],
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  };
  const bridge = new AppBridge(
    client,
    { name: "Local SDK harness (not OpenAI)", version: "0.0.0" },
    { serverTools: {}, logging: {} },
    { hostContext: context },
  );
  const sendInitialResult = async () => {
    status.textContent =
      "SDK bridge initialized. Tool/resource loaded from the real fixture MCP endpoint.";
    await bridge.sendToolInput({ arguments: { scenario: "populated" } });
    await bridge.sendToolResult(
      await client.callTool({ name: tool.name, arguments: { scenario: "populated" } }),
    );
  };
  bridge.oninitialized = () => {
    void sendInitialResult().catch((error) => {
      status.textContent = `Initial fixture failed: ${error.message}`;
    });
  };
  bridge.onsizechange = ({ height }) => {
    if (height) iframe.style.height = `${Math.max(600, height)}px`;
  };
  await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
  iframe.srcdoc = resource.contents[0].text;
  document.getElementById("layout").addEventListener("change", (event) => {
    iframe.style.width = event.target.value === "narrow" ? "360px" : "min(900px,100%)";
  });
  document.getElementById("theme").addEventListener("change", (event) => {
    // AppBridge retains this object for change detection. Do not mutate it.
    context = { ...context, theme: event.target.value };
    bridge.setHostContext(context);
  });
  window.addEventListener("pagehide", () => {
    void bridge.close();
    void client.close();
  });
} catch (error) {
  status.textContent = `Harness failed: ${error.message}`;
}
