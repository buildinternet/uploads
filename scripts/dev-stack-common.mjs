/** Shared local-stack endpoints, cookie jar, fixture uploads, and smoke flow. */
export const AUTH_ORIGIN = "http://127.0.0.1:8788";
export const API_ORIGIN = "http://127.0.0.1:8787";
export const WEB_ORIGIN = "http://127.0.0.1:4321";
export const PREVIEW_URL = `${WEB_ORIGIN}/account/workspaces`;
export const DEMO_WORKSPACE = "dev-demo";

// A valid 1×1 PNG. Fixture uploads traverse the same magic-byte validation as
// real clients, so the local browser has meaningful nested paths to inspect.
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0WQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const FIXTURES = ["screenshots/feature/after.png", "gh/pr-120/before.png"];

function recordSetCookies(response, jar) {
  const values = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  for (const value of values) {
    const match = value.match(/^([^=;]+)=([^;]*)/);
    if (match) jar.set(match[1], match[2]);
  }
}

function cookieHeader(jar) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function boundedFetch(url, init, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function request(url, init, jar) {
  const headers = new Headers(init?.headers);
  const cookie = cookieHeader(jar);
  if (cookie) headers.set("cookie", cookie);
  const response = await boundedFetch(url, { ...init, headers });
  recordSetCookies(response, jar);
  return response;
}

async function requireOk(response, label) {
  if (response.ok) return;
  const text = await response.text().catch(() => "");
  throw new Error(`${label} failed (${response.status})${text ? `: ${text.slice(0, 240)}` : ""}`);
}

export async function waitFor(url, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not started";
  while (Date.now() < deadline) {
    try {
      const response = await boundedFetch(url, undefined, 2_000);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `${label} did not become ready within ${Math.round(timeoutMs / 1000)}s (${lastError})`,
  );
}

/** Upload the normal API fixtures with the newly minted dev-demo bearer token. */
export async function seedFixtures(token) {
  for (const key of FIXTURES) {
    const response = await boundedFetch(
      `${API_ORIGIN}/v1/${encodeURIComponent(DEMO_WORKSPACE)}/files/${key}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/png" },
        body: PNG,
      },
    );
    await requireOk(response, `fixture upload ${key}`);
  }
}

/**
 * End-to-end proof for separate Worker sessions: create a browser cookie,
 * validate it at auth, then exercise API membership and local R2 listing.
 */
export async function runSmoke() {
  const jar = new Map();
  const demo = await request(
    `${AUTH_ORIGIN}/api/auth/dev-session`,
    {
      method: "POST",
      // better-call (better-auth's router) sees a non-null `request.body`
      // for every POST under the Workers runtime, even with no body
      // supplied, so it always runs its Content-Type gate and 415s without
      // this header (see apps/web/src/lib/auth-client.ts's matching fix).
      headers: { Origin: WEB_ORIGIN, "Content-Type": "application/json" },
      body: "{}",
    },
    jar,
  );
  await requireOk(demo, "local demo session");

  const session = await request(`${AUTH_ORIGIN}/api/auth/get-session`, {}, jar);
  await requireOk(session, "auth get-session");
  const sessionBody = await session.json();
  if (sessionBody?.user?.email !== "dev-demo@uploads.local") {
    throw new Error("auth get-session did not return the local demo user");
  }

  const workspaces = await request(
    `${API_ORIGIN}/me/workspaces`,
    { headers: { Origin: WEB_ORIGIN } },
    jar,
  );
  await requireOk(workspaces, "API workspace membership");
  const workspaceBody = await workspaces.json();
  const names = workspaceBody?.workspaces?.map((workspace) => workspace.workspace);
  if (!Array.isArray(names) || !names.includes(DEMO_WORKSPACE) || names.includes("default")) {
    throw new Error("demo membership did not resolve only the expected dev-demo workspace");
  }

  const files = await request(
    `${API_ORIGIN}/me/workspaces/${DEMO_WORKSPACE}/files`,
    { headers: { Origin: WEB_ORIGIN } },
    jar,
  );
  await requireOk(files, "API demo file listing");
  const fileBody = await files.json();
  const keys = fileBody?.files?.map((file) => file.key);
  if (!Array.isArray(keys) || !FIXTURES.every((key) => keys.includes(key))) {
    throw new Error("demo file listing is missing the seeded nested PNG fixtures");
  }
  if (keys.some((key) => key.startsWith(`${DEMO_WORKSPACE}/`))) {
    throw new Error("demo file listing exposed the workspace storage prefix");
  }

  return {
    user: sessionBody.user.email,
    workspace: DEMO_WORKSPACE,
    files: keys,
    previewUrl: PREVIEW_URL,
  };
}
