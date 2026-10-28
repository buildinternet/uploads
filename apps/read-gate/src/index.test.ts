import { describe, expect, it, vi } from "vitest";
import { cacheRequest, handleReadGate, objectKeyFromUrl, type ReadGateEnv } from "./index";

function ctx() {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
  };
}

function db(first: () => Promise<unknown>) {
  const calls: string[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        calls.push(sql);
        return {
          bind() {
            return { first };
          },
        };
      },
    },
  } as unknown as ReadGateEnv;
  return { env, calls };
}

describe("objectKeyFromUrl", () => {
  it("reads a Slack PNG transform back to the object key", () => {
    expect(
      objectKeyFromUrl(
        "https://storage.uploads.sh/cdn-cgi/image/width=1600,fit=scale-down,format=png/acme/shot.avif",
      ),
    ).toBe("acme/shot.avif");
  });
});

describe("handleReadGate", () => {
  it("404s a held key, including its Slack PNG, and passes other keys through", async () => {
    const origin = vi.fn(async () => new Response("bytes", { status: 200 }));
    vi.stubGlobal("fetch", origin);
    const { env } = db(async () => ({ hit: 1 }));
    const blocked = new Request("https://embed.uploads.sh/acme/shot.avif");
    const png = new Request(
      "https://storage.uploads.sh/cdn-cgi/image/width=1600,fit=scale-down,format=png/acme/shot.avif",
    );
    const held = await handleReadGate(blocked, env, ctx());
    const transformed = await handleReadGate(png, env, ctx());
    expect(held.status).toBe(404);
    expect(await held.json()).toEqual({
      error: { code: "not_found", type: "not_found", message: "Not found." },
    });
    expect(transformed.status).toBe(404);
    expect(origin).not.toHaveBeenCalled();

    const { env: open } = db(async () => null);
    const other = new Request("https://store.uploads.sh/acme/other.png");
    const response = await handleReadGate(other, open, ctx());
    expect(response.status).toBe(200);
    expect(origin).toHaveBeenCalledOnce();
    expect(origin).toHaveBeenCalledWith(other);
    vi.unstubAllGlobals();
  });

  it("passes OPTIONS through without a lookup", async () => {
    const origin = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", origin);
    const { env, calls } = db(async () => {
      throw new Error("lookup");
    });
    const request = new Request("https://embed.uploads.sh/acme/shot.png", { method: "OPTIONS" });
    const response = await handleReadGate(request, env, ctx());
    expect(response.status).toBe(204);
    expect(origin).toHaveBeenCalledWith(request);
    expect(calls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("fails open when D1 errors and does not cache that miss", async () => {
    const origin = vi.fn(async () => new Response("bytes", { status: 200 }));
    vi.stubGlobal("fetch", origin);
    let lookups = 0;
    const { env } = db(async () => {
      lookups += 1;
      throw new Error("D1_ERROR: internal");
    });
    const request = new Request("https://storage.uploads.sh/acme/shot.png");
    const gate = ctx();
    expect((await handleReadGate(request, env, gate)).status).toBe(200);
    expect((await handleReadGate(request, env, gate)).status).toBe(200);
    expect(lookups).toBe(2);
    expect(origin).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("reads a replica session and caches on the request host", async () => {
    const origin = vi.fn(async () => new Response("bytes", { status: 200 }));
    vi.stubGlobal("fetch", origin);
    const puts: string[] = [];
    vi.stubGlobal("caches", {
      default: {
        async match() {
          return undefined;
        },
        async put(request: Request) {
          puts.push(request.url);
        },
      },
    });
    let mode = "";
    const session = {
      prepare() {
        return {
          bind() {
            return { first: async () => null };
          },
        };
      },
    };
    const env = {
      DB: {
        withSession(value: string) {
          mode = value;
          return session;
        },
        prepare() {
          throw new Error("primary");
        },
      },
    } as unknown as ReadGateEnv;
    const request = new Request("https://store.uploads.sh/acme/shot.png");
    expect((await handleReadGate(request, env, ctx())).status).toBe(200);
    expect(mode).toBe("first-unconstrained");
    expect(puts).toEqual([cacheRequest("store.uploads.sh", "acme/shot.png").url]);
    vi.unstubAllGlobals();
  });

  it("gates an extra hosted host and lets an unknown host through", async () => {
    const origin = vi.fn(async () => new Response("bytes", { status: 200 }));
    vi.stubGlobal("fetch", origin);
    const { env, calls } = db(async () => ({ hit: 1 }));
    env.EXTRA_HOSTED_HOSTS = "read-gate-staging.uploads.sh";
    const gated = await handleReadGate(
      new Request("https://read-gate-staging.uploads.sh/cdn-cgi/image/format=png/acme/shot.avif"),
      env,
      ctx(),
    );
    expect(gated.status).toBe(404);
    expect(await gated.json()).toEqual({
      error: { code: "not_found", type: "not_found", message: "Not found." },
    });
    expect(origin).not.toHaveBeenCalled();

    const unknown = new Request("https://other.uploads.sh/acme/shot.avif");
    const passed = await handleReadGate(unknown, env, ctx());
    expect(passed.status).toBe(200);
    expect(origin).toHaveBeenCalledOnce();
    expect(origin).toHaveBeenCalledWith(unknown);
    expect(calls).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("404s /__read-gate/ without forwarding to the origin", async () => {
    const origin = vi.fn(async () => new Response("origin", { status: 200 }));
    vi.stubGlobal("fetch", origin);
    const { env, calls } = db(async () => ({ hit: 1 }));
    const response = await handleReadGate(
      new Request("https://embed.uploads.sh/__read-gate/acme%2Fshot.png/extra"),
      env,
      ctx(),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", type: "not_found", message: "Not found." },
    });
    expect(origin).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("treats a cache hit without x-read-gate as a miss", async () => {
    const origin = vi.fn(async () => new Response("bytes", { status: 200 }));
    vi.stubGlobal("fetch", origin);
    vi.stubGlobal("caches", {
      default: {
        async match() {
          return new Response(null, { status: 404 });
        },
        async put() {},
      },
    });
    let lookups = 0;
    const { env } = db(async () => {
      lookups += 1;
      return { hit: 1 };
    });
    const response = await handleReadGate(
      new Request("https://storage.uploads.sh/acme/shot.png"),
      env,
      ctx(),
    );
    expect(response.status).toBe(404);
    expect(lookups).toBe(1);
    expect(origin).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
