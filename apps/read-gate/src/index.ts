/**
 * Route in front of the hosted bucket (embed, storage, store, and any
 * EXTRA_HOSTED_HOSTS). A held image returns a static "Held for review" PNG
 * with `no-store`. Status 200 keeps the zone's branded 404 page from
 * replacing the body, so a GitHub embed shows the card, and `no-store`
 * drops it once the hold lifts. Any other held key 404s with the API's
 * not-found envelope. Everything else is the original request, so R2 keeps
 * Range, validators, content type, and CORS. That pass-through adds
 * `must-revalidate` so a cached `/cdn-cgi/image/` variant follows the
 * object's max-age (60s on hosted uploads) instead of Cloudflare Images'
 * one-hour minimum. OPTIONS skips the gate. A D1 error serves the object.
 * That is a choice, the same as the classifier's fail-open: a lookup
 * outage must not hide the public bucket. This Worker does not bind the
 * held bucket.
 */

import placeholder from "./held-placeholder.png";

/** Same lane string as `HOSTED_READ_LANE` in apps/api/src/read-gate.ts. */
const HOSTED_LANE = "hosted";

const HOSTED_HOSTS = new Set(["embed.uploads.sh", "storage.uploads.sh", "store.uploads.sh"]);

const GATE_TTL_SECONDS = 30;

// Same lifetime as `UPLOAD_CACHE_CONTROL` in apps/api/src/files-core.ts.
// Used only when the origin sends no Cache-Control.
const HOSTED_CACHE_CONTROL = "public, max-age=60, must-revalidate";

const NOT_FOUND_BODY = JSON.stringify({
  error: { code: "not_found", type: "not_found", message: "Not found." },
});

/** Raster types an embed actually renders. Same set as the upload allowlist. */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif"]);

export interface ReadGateEnv {
  DB: D1Database;
  EXTRA_HOSTED_HOSTS?: string;
}

interface GateContext {
  waitUntil(promise: Promise<unknown>): void;
}

function isHostedHost(hostname: string, extra: string | undefined): boolean {
  const host = hostname.toLowerCase();
  if (HOSTED_HOSTS.has(host)) return true;
  if (!extra) return false;
  return extra.split(",").some((part) => part.trim().toLowerCase() === host);
}

/** Public object key for a hosted URL, or null when there is nothing to gate. */
export function objectKeyFromUrl(
  raw: string,
  env: Pick<ReadGateEnv, "EXTRA_HOSTED_HOSTS"> = {},
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!isHostedHost(url.hostname, env.EXTRA_HOSTED_HOSTS)) return null;
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

/** In-zone cache key. `cache.put` on a route Worker ignores a foreign host. */
export function cacheRequest(hostname: string, objectKey: string): Request {
  return new Request(`https://${hostname}/__read-gate/${encodeURIComponent(objectKey)}`);
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

function gateDb(env: ReadGateEnv): Pick<D1Database, "prepare"> {
  return typeof env.DB.withSession === "function"
    ? env.DB.withSession("first-unconstrained")
    : env.DB;
}

async function isBlocked(
  env: ReadGateEnv,
  ctx: GateContext,
  hostname: string,
  objectKey: string,
): Promise<boolean> {
  const cachedRequest = cacheRequest(hostname, objectKey);
  const hit = await readCache(cachedRequest);
  const mark = hit?.headers.get("x-read-gate");
  if (mark === "block") return true;
  if (mark === "allow") return false;
  try {
    const row = await gateDb(env)
      .prepare(`SELECT 1 AS hit FROM read_gate WHERE lane = ? AND object_key = ?`)
      .bind(HOSTED_LANE, objectKey)
      .first();
    const blocked = row != null;
    remember(ctx, cachedRequest, blocked);
    return blocked;
  } catch (err) {
    // A D1 error serves the object, by choice. Same fail-open as the
    // classifier: an outage must not 404 every public file.
    console.error({ event: "read_gate_lookup_failed", err });
    return false;
  }
}

/**
 * Cloudflare Images caches a transformed variant for at least one hour when
 * the source response has no `must-revalidate`. Append the directive and
 * keep the object's max-age. Leave `no-store` (the embed zone rule) alone.
 */
export function withMustRevalidate(response: Response): Response {
  const current = response.headers.get("cache-control");
  if (current && /\b(?:must-revalidate|no-store)\b/i.test(current)) return response;
  const headers = new Headers(response.headers);
  headers.set("cache-control", current ? `${current}, must-revalidate` : HOSTED_CACHE_CONTROL);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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

/** True when the object key is a raster image an embed would try to draw. */
export function isHeldImageKey(objectKey: string): boolean {
  const slash = objectKey.lastIndexOf("/");
  const name = slash === -1 ? objectKey : objectKey.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return false;
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * The zone custom error rule replaces a 404 body with the branded HTML
 * page. A 200 image is what GitHub and Slack can draw. `no-store` so the
 * card is not the response after the hold lifts. PNG, not the source SVG:
 * GitHub Camo does not render SVG.
 */
function heldImage(method: string): Response {
  return new Response(method === "HEAD" ? null : placeholder.slice(0), {
    status: 200,
    headers: {
      "content-type": "image/png",
      "cache-control": "no-store",
    },
  });
}

/** The Cache API key lives on the public host. Never forward that path to R2. */
function isReservedGatePath(pathname: string): boolean {
  return pathname === "/__read-gate" || pathname.startsWith("/__read-gate/");
}

export async function handleReadGate(
  request: Request,
  env: ReadGateEnv,
  ctx: GateContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (isReservedGatePath(url.pathname)) return heldNotFound();
  if (request.method === "OPTIONS") return fetch(request);
  const objectKey = objectKeyFromUrl(request.url, env);
  if (!objectKey) return fetch(request);
  if (await isBlocked(env, ctx, url.hostname, objectKey)) {
    return isHeldImageKey(objectKey) ? heldImage(request.method) : heldNotFound();
  }
  return withMustRevalidate(await fetch(request));
}

export default {
  fetch(request: Request, env: ReadGateEnv, ctx: ExecutionContext): Promise<Response> {
    return handleReadGate(request, env, ctx);
  },
};
