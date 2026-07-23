/**
 * GET /cli-version.json — published latest for @buildinternet/uploads.
 *
 * Account UI uses this (same-origin) instead of calling the npm registry from
 * the browser, so CORS and ad-blockers don't break the upgrade callout.
 * Cached briefly at the edge/browser so we don't hammer npm.
 */
import type { APIRoute } from "astro";

export const prerender = false;

const NPM_LATEST =
  "https://registry.npmjs.org/" + encodeURIComponent("@buildinternet/uploads") + "/latest";
const FETCH_TIMEOUT_MS = 2500;

export const GET: APIRoute = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(NPM_LATEST, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "uploads.sh-web/cli-version",
      },
    });
    if (!res.ok) {
      return json({ error: "upstream_unavailable" }, 502);
    }
    const body = (await res.json()) as { version?: unknown };
    if (typeof body.version !== "string" || !body.version.trim()) {
      return json({ error: "invalid_upstream" }, 502);
    }
    return json(
      {
        package: "@buildinternet/uploads",
        latest: body.version.trim(),
      },
      200,
      // Short shared cache: upgrades show up within ~10 minutes without a redeploy.
      "public, max-age=300, s-maxage=600, stale-while-revalidate=3600",
    );
  } catch {
    return json({ error: "upstream_unavailable" }, 502);
  } finally {
    clearTimeout(timer);
  }
};

function json(body: Record<string, unknown>, status: number, cacheControl = "no-store"): Response {
  return new Response(JSON.stringify(body) + "\n", {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheControl,
    },
  });
}
