import { randomUUID } from "node:crypto";

const required = ["UPLOADS_API_URL", "UPLOADS_MCP_URL", "UPLOADS_WORKSPACE", "ADMIN_TOKEN"];
for (const name of required) {
  if (!process.env[name]) throw new Error(`missing required environment variable: ${name}`);
}

const apiUrl = process.env.UPLOADS_API_URL.replace(/\/$/, "");
const mcpUrl = process.env.UPLOADS_MCP_URL.replace(/\/$/, "");
const workspace = process.env.UPLOADS_WORKSPACE;
const adminToken = process.env.ADMIN_TOKEN;
const runId = randomUUID();
const label = `remote-mcp-smoke-${runId}`;
const key = `f/mcp-smoke/${runId}.png`;
const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XDRZ4wAAAABJRU5ErkJggg==";

let rpcId = 0;
let scopedToken;
let putAttempted = false;
let exchanged = false;

function mask(value) {
  if (process.env.GITHUB_ACTIONS === "true") process.stdout.write(`::add-mask::${value}\n`);
}

function ok(step) {
  process.stdout.write(`ok ${step}\n`);
}

function errorCode(body) {
  if (typeof body?.error === "string") return body.error;
  return typeof body?.error?.code === "string" ? body.error.code : undefined;
}

function failureHint(code) {
  switch (code) {
    case "workspace_not_found":
      return `verify that workspace ${JSON.stringify(workspace)} exists`;
    case "unauthorized":
      return "verify the protected environment credential is current";
    case "invalid_scopes":
      return "verify the deployed API accepts the smoke-test scopes";
    default:
      return undefined;
  }
}

async function jsonRequest(url, options, expected = [200], operation = "HTTP request") {
  const response = await fetch(url, options);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${operation} returned non-JSON status ${response.status}`);
  }
  if (!expected.includes(response.status)) {
    const code = errorCode(body);
    const hint = failureHint(code);
    throw new Error(
      `${operation} expected HTTP ${expected.join("/")}, got ${response.status}${code ? ` (${code})` : ""}${hint ? `; ${hint}` : ""}`,
    );
  }
  return { status: response.status, body };
}

function headers(token) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function mcp(method, params, expected = [200]) {
  return jsonRequest(
    mcpUrl,
    {
      method: "POST",
      headers: headers(scopedToken),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method,
        ...(params ? { params } : {}),
      }),
    },
    expected,
    `MCP ${method}`,
  );
}

async function tool(name, args) {
  const { body } = await mcp("tools/call", { name, arguments: args });
  if (body.error || body.result?.isError) throw new Error(`MCP tool failed: ${name}`);
  return body.result?.structuredContent;
}

async function revoke() {
  await jsonRequest(
    `${apiUrl}/admin/tokens`,
    {
      method: "DELETE",
      headers: headers(adminToken),
      body: JSON.stringify({ workspace, label }),
    },
    [200],
    "revoke smoke token",
  );
}

try {
  const enrollment = await jsonRequest(
    `${apiUrl}/admin/enrollments`,
    {
      method: "POST",
      headers: headers(adminToken),
      body: JSON.stringify({
        workspace,
        label,
        enrollmentSeconds: 300,
        tokenExpiresInSeconds: 900,
        scopes: ["files:read", "files:write", "files:delete"],
      }),
    },
    [201],
    "create enrollment",
  );
  const code = enrollment.body.code;
  if (typeof code !== "string") throw new Error("enrollment response missing code");
  mask(code);
  ok("enrollment");

  const exchange = await jsonRequest(
    `${apiUrl}/auth/enrollments/exchange`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    },
    [201],
    "exchange enrollment",
  );
  if (exchange.body.workspace !== workspace || typeof exchange.body.token !== "string") {
    throw new Error("enrollment exchange returned invalid credentials");
  }
  scopedToken = exchange.body.token;
  exchanged = true;
  mask(scopedToken);
  ok("exchange");

  const initialized = await mcp("initialize", { protocolVersion: "2025-06-18" });
  if (initialized.body.result?.protocolVersion !== "2025-06-18") {
    throw new Error("MCP initialize returned unexpected protocol version");
  }
  ok("initialize");

  const listedTools = await mcp("tools/list");
  const toolNames = new Set(listedTools.body.result?.tools?.map((item) => item.name));
  for (const name of ["put", "list", "delete"]) {
    if (!toolNames.has(name)) throw new Error(`MCP tools/list missing required tool: ${name}`);
  }
  ok("tools/list");

  putAttempted = true;
  const put = await tool("put", { contentBase64: pngBase64, filename: "smoke.png", key });
  if (put?.key !== key) throw new Error("MCP put returned unexpected key");
  ok("put");

  const list = await tool("list", { prefix: key });
  if (!list?.items?.some((item) => item.key === key)) {
    throw new Error("MCP list did not return uploaded key");
  }
  ok("list");
} finally {
  try {
    if (putAttempted && scopedToken) {
      await tool("delete", { key });
      ok("cleanup");
    }
  } finally {
    if (exchanged) {
      await revoke();
      ok("revoke");
    }
  }
}

const rejected = await mcp("tools/list", undefined, [401]);
if (errorCode(rejected.body) !== "unauthorized") {
  throw new Error("revoked token returned an unexpected authentication error");
}
ok("revoked token");
