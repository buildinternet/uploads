import assert from "node:assert/strict";
import { request } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startServer, resourceUri, toolName } from "./server.mjs";

const server = await startServer(0);
const endpoint = new URL(`http://127.0.0.1:${server.port}/mcp`);
const client = new Client({ name: "uploads-spike-smoke", version: "0.0.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const { tools } = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, toolName);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.equal(tools[0]._meta.ui.resourceUri, resourceUri);
  assert.deepEqual(tools[0]._meta["openai/ui"].entrypoints, [
    { type: "global" },
    { type: "thread" },
  ]);
  const { resources } = await client.listResources();
  assert.equal(resources.length, 1);
  const resource = await client.readResource({ uri: resourceUri });
  assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(resource.contents[0].text, /Staged media/);
  const populated = await client.callTool({ name: toolName, arguments: { scenario: "populated" } });
  assert.equal(populated.structuredContent.demo, true);
  assert.equal(populated.structuredContent.files.length, 2);
  assert.match(populated.content[0].text, /Synthetic demo only/);
  const empty = await client.callTool({ name: toolName, arguments: { scenario: "empty" } });
  assert.deepEqual(empty.structuredContent.files, []);
  const error = await client.callTool({ name: toolName, arguments: { scenario: "error" } });
  assert.equal(error.isError, true);
  const invalid = await client.callTool({
    name: toolName,
    arguments: { scenario: "real", url: "https://example.com" },
  });
  assert.equal(invalid.isError, true);
  const legacy = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "legacy-smoke", version: "0.0.0" },
      },
    }),
  });
  assert.equal(legacy.status, 200);
  assert.match(await legacy.text(), /protocolVersion/);
  const forbidden = await fetch(new URL("/package.json", endpoint));
  assert.equal(forbidden.status, 404);
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = request(endpoint, { headers: { host: "untrusted.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(badHostStatus, 403);
  const badOrigin = await fetch(endpoint, { headers: { origin: "https://untrusted.example" } });
  assert.equal(badOrigin.status, 403);
  console.log(
    "PASS: tool/resource metadata, populated/empty/error, invalid input, legacy initialize, route allowlist, host/origin guards.",
  );
} finally {
  await client.close();
  await server.close();
}
