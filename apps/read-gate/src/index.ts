/**
 * Route in front of the hosted bucket (embed, storage, and store). A held
 * key 404s with the API's not-found envelope. Everything else is the
 * original request, so R2 keeps Range, validators, content type, and CORS.
 * OPTIONS skips the gate. D1 errors fail open: the held bucket is still
 * the backstop, and this Worker does not bind it.
 */

/** Same lane string as `HOSTED_READ_LANE` in apps/api/src/read-gate.ts. */
const HOSTED_LANE = "hosted";

const HOSTED_HOSTS = new Set(["embed.uploads.sh", "storage.uploads.sh", "store.uploads.sh"]);

const GATE_TTL_SECONDS = 30;

const NOT_FOUND_BODY = JSON.stringify({
  error: { code: "not_found", type: "not_found", message: "Not found." },
});

export interface ReadGateEnv {
  DB: D1Database;
}

interface GateContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Public object key for a hosted URL, or null when there is nothing to gate. */
export function objectKeyFromUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!HOSTED_HOSTS.has(url.hostname.toLowerCase())) return null;
  let path: string;
  try {
    path = url.pathname
      .replace(/^\/+/, "")
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    return null;
  }
  // Slack asks for AVIF as `/cdn-cgi/image/…format=png/<key>`. The key is the source path.
  if (path.startsWith("cdn-cgi/image/")) {
    const rest = path.slice("cdn-cgi/image/".length);
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    path = rest.slice(slash + 1);
  }
  return path.length > 0 ? path : null;
}

function gateCache(): Cache | undefined {
  try {
    return (globalThis as { caches?: { default?: Cache } }).caches?.default;
  } catch {
    return undefined;
  }
}

function cacheRequest(objectKey: string): Request {
  return new Request(`https://read-gate.internal/hosted/${encodeURIComponent(objectKey)}`);
}

async function readCache(request: Request): Promise<Response | undefined> {
  const cache = gateCache();
  if (!cache) return undefined;
  try {
    return await cache.match(request);
  } catch {
    return undefined;
  }
}

function remember(ctx: GateContext, request: Request, blocked: boolean): void {
  const cache = gateCache();
  if (!cache) return;
  const response = new Response(null, {
    status: 200,
    headers: {
      "cache-control": `public, max-age=${GATE_TTL_SECONDS}`,
      "x-read-gate": blocked ? "block" : "allow",
    },
  });
  try {
    ctx.waitUntil(cache.put(request, response).catch(() => undefined));
  } catch {
    // A cache write must not turn a successful lookup into a failure.
  }
}

async function isBlocked(env: ReadGateEnv, ctx: GateContext, objectKey: string): Promise<boolean> {
  const cachedRequest = cacheRequest(objectKey);
  const hit = await readCache(cachedRequest);
  if (hit) return hit.headers.get("x-read-gate") === "block";
  try {
    const row = await env.DB.prepare(
      `SELECT 1 AS hit FROM read_gate WHERE lane = ? AND object_key = ?`,
    )
      .bind(HOSTED_LANE, objectKey)
      .first();
    const blocked = row != null;
    remember(ctx, cachedRequest, blocked);
    return blocked;
  } catch (err) {
    console.error({ event: "read_gate_lookup_failed", err });
    return false;
  }
}

function heldNotFound(): Response {
  return new Response(NOT_FOUND_BODY, {
    status: 404,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export async function handleReadGate(
  request: Request,
  env: ReadGateEnv,
  ctx: GateContext,
): Promise<Response> {
  if (request.method === "OPTIONS") return fetch(request);
  const objectKey = objectKeyFromUrl(request.url);
  if (!objectKey) return fetch(request);
  if (await isBlocked(env, ctx, objectKey)) return heldNotFound();
  return fetch(request);
}

export default {
  fetch(request: Request, env: ReadGateEnv, ctx: ExecutionContext): Promise<Response> {
    return handleReadGate(request, env, ctx);
  },
};
