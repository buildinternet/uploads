import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostActiveContentKey } from "../active-content-hosts";
import { respondError } from "../error-response";
import { FakeR2Bucket } from "../../test/fake-r2";
import { admin } from "./admin";

const ADMIN_TOKEN = "test-admin-token";

if (typeof crypto.subtle.timingSafeEqual !== "function") {
  (
    crypto.subtle as unknown as { timingSafeEqual: (a: Uint8Array, b: Uint8Array) => boolean }
  ).timingSafeEqual = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** In-memory REGISTRY KV stand-in — get/put over a Map. */
function fakeRegistry(records: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(records));
  return {
    store,
    get: (async (key: string) => store.get(key) ?? null) as unknown as KVNamespace["get"],
    put: (async (key: string, value: string) => {
      store.set(key, JSON.parse(value));
    }) as unknown as KVNamespace["put"],
  };
}

/** A passing response for either probe object — the probe writes an SVG and an XML one (issue #929 M-1). */
function okProbeResponse(url: string): Response {
  return new Response("<probe/>", {
    status: 200,
    headers: {
      "content-type": String(url).endsWith(".xml") ? "application/xml" : "image/svg+xml",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}

function appWith(registry: ReturnType<typeof fakeRegistry>) {
  const app = new Hono<{ Bindings: Env }>()
    .route("/admin", admin)
    .onError((err, c) => respondError(c, err));
  const env = {
    ADMIN_TOKEN,
    REGISTRY: registry,
    UPLOADS_DEFAULT: new FakeR2Bucket(),
  } as unknown as Env;
  return { app, env };
}

function probeRequest(bearer?: string) {
  return new Request("https://api.uploads.sh/admin/active-content/probe", {
    method: "POST",
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

/**
 * `POST /admin/active-content/probe` (issue #929 final-review item 2) — the
 * token-authed counterpart to the session-gated `/admin-ui/active-content
 * /probe` route, so an operator holding only `ADMIN_TOKEN` (or an
 * `operator:write` scoped token, via the shared `adminAuth` gate every
 * route on this router goes through) can confirm a just-applied Transform
 * Rule without a browser session.
 */
describe("POST /admin/active-content/probe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("401s without a valid admin token", async () => {
    const { app, env } = appWith(fakeRegistry());
    const res = await app.request(probeRequest(), {}, env);
    expect(res.status).toBe(401);
  });

  it("runs the hosted-host sweep and returns + persists the fresh per-host records", async () => {
    const registry = fakeRegistry();
    const { app, env } = appWith(registry);
    const fetchSpy = vi.fn(async (url: string) => okProbeResponse(url));
    vi.stubGlobal("fetch", fetchSpy);

    const res = await app.request(probeRequest(ADMIN_TOKEN), {}, env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      records: Record<string, { ok: boolean; verifiedAt: string }>;
    };
    expect(body.records["storage.uploads.sh"]).toMatchObject({ ok: true });
    expect(body.records["store.uploads.sh"]).toMatchObject({ ok: true });
    expect(body.records["embed.uploads.sh"]).toMatchObject({ ok: true });
    expect(fetchSpy).toHaveBeenCalled();

    // Same records the response carried are what `activeContentAllowed`
    // (../active-content.ts) reads back out of REGISTRY.
    expect(registry.store.get(hostActiveContentKey("storage.uploads.sh"))).toMatchObject({
      ok: true,
    });
  });
});
