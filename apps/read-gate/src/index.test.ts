import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  cacheRequest,
  handleReadGate,
  isHeldImageKey,
  objectKeyFromUrl,
  withMustRevalidate,
  type ReadGateEnv,
} from "./index";

const PLACEHOLDER = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "held-placeholder.png"),
);

async function expectPlaceholder(response: Response): Promise<void> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(PLACEHOLDER));
}

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

describe("isHeldImageKey", () => {
  it("matches raster extensions and ignores every other key", () => {
    for (const key of [
      "acme/shot.png",
      "acme/shot.JPEG",
      "acme/shot.jpg",
      "acme/shot.jpeg",
      "acme/shot.gif",
      "acme/shot.webp",
      "acme/shot.avif",
      "_internal/posters/acme/clip.mp4.jpg",
    ]) {
      expect(isHeldImageKey(key)).toBe(true);
    }
    for (const key of [
      "acme/clip.mp4",
      "acme/notes.pdf",
      "acme/page.svg",
      "acme/readme.md",
      "acme/noext",
      "acme/.png",
      "acme/shot.png.",
    ]) {
      expect(isHeldImageKey(key)).toBe(false);
    }
  });
});

describe("handleReadGate", () => {
  it("returns the held card for an image, including its Slack PNG, and 404s other keys", async () => {
    const origin = vi.fn(async () => new Response("bytes", { status: 200 }));
    vi.stubGlobal("fetch", origin);
    const { env } = db(async () => ({ hit: 1 }));
    const blocked = new Request("https://embed.uploads.sh/acme/shot.avif");
    const png = new Request(
      "https://storage.uploads.sh/cdn-cgi/image/width=1600,fit=scale-down,format=png/acme/shot.avif",
    );
    const pdf = new Request("https://store.uploads.sh/acme/notes.pdf");
    const held = await handleReadGate(blocked, env, ctx());
    const transformed = await handleReadGate(png, env, ctx());
    const otherFile = await handleReadGate(pdf, env, ctx());
    await expectPlaceholder(held);
    await expectPlaceholder(transformed);
    expect(otherFile.status).toBe(404);
    expect(otherFile.headers.get("content-type")).toBe("application/json");
    expect(otherFile.headers.get("cache-control")).toBe("no-store");
    expect(await otherFile.json()).toEqual({
      error: { code: "not_found", type: "not_found", message: "Not found." },
    });
    expect(origin).not.toHaveBeenCalled();

    const { env: open } = db(async () => null);
    const other = new Request("https://store.uploads.sh/acme/other.png");
    const response = await handleReadGate(other, open, ctx());
    expect(response.status).toBe(200);
    expect(origin).toHaveBeenCalledOnce();
    expect(origin).toHaveBeenCalledWith(other);
    vi.unstubAllGlobals();
  });

  it("answers a GET/HEAD preflight for any origin without a lookup", async () => {
    const origin = vi.fn(async () => new Response("nope", { status: 403 }));
    vi.stubGlobal("fetch", origin);
    const { env, calls } = db(async () => {
      throw new Error("lookup");
    });
    for (const host of ["embed.uploads.sh", "storage.uploads.sh", "store.uploads.sh"]) {
      const request = new Request(`https://${host}/acme/shot.png`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://docs.example",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "range, if-none-match",
        },
      });
      const response = await handleReadGate(request, env, ctx());
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-allow-methods")).toBe("GET, HEAD");
      expect(response.headers.get("access-control-allow-headers")).toBe("range, if-none-match");
      expect(response.headers.get("access-control-max-age")).toBe("86400");
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
      expect(response.headers.get("vary")).toBe("Access-Control-Request-Headers");
    }
    const plain = await handleReadGate(
      new Request("https://embed.uploads.sh/acme/shot.png", {
        method: "OPTIONS",
        headers: { Origin: "https://app.slack.com", "Access-Control-Request-Method": "HEAD" },
      }),
      env,
      ctx(),
    );
    expect(plain.status).toBe(204);
    expect(plain.headers.get("access-control-allow-origin")).toBe("*");
    expect(plain.headers.get("access-control-allow-headers")).toBeNull();
    const write = await handleReadGate(
      new Request("https://storage.uploads.sh/acme/shot.png", {
        method: "OPTIONS",
        headers: { Origin: "https://docs.example", "Access-Control-Request-Method": "PUT" },
      }),
      env,
      ctx(),
    );
    expect(write.status).toBe(204);
    expect(write.headers.get("access-control-allow-methods")).toBe("GET, HEAD");
    expect(origin).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("adds the same CORS origin on hosted GET and HEAD, including holds", async () => {
    const origin = vi.fn(async (request: Request) => {
      const headers = {
        "access-control-allow-origin": "https://app.slack.com",
        "cache-control": "public, max-age=60",
        etag: '"abc"',
        vary: "Origin",
      };
      return new Response(request.method === "HEAD" ? null : "bytes", { status: 200, headers });
    });
    vi.stubGlobal("fetch", origin);
    const { env } = db(async () => null);
    const get = await handleReadGate(
      new Request("https://storage.uploads.sh/acme/shot.png", {
        headers: { Origin: "https://docs.example" },
      }),
      env,
      ctx(),
    );
    expect(get.status).toBe(200);
    expect(get.headers.get("access-control-allow-origin")).toBe("*");
    expect(get.headers.get("access-control-allow-credentials")).toBeNull();
    expect(get.headers.get("vary")).toBeNull();
    expect(get.headers.get("etag")).toBe('"abc"');
    expect(get.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
    expect(await get.text()).toBe("bytes");
    const head = await handleReadGate(
      new Request("https://embed.uploads.sh/acme/shot.png", { method: "HEAD" }),
      env,
      ctx(),
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("access-control-allow-origin")).toBe("*");
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    const unchanged = new Response(null, {
      status: 304,
      headers: { etag: '"abc"', vary: "Accept" },
    });
    origin.mockResolvedValueOnce(unchanged);
    const notModified = await handleReadGate(
      new Request("https://store.uploads.sh/acme/shot.png", {
        headers: { "if-none-match": '"abc"' },
      }),
      env,
      ctx(),
    );
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe('"abc"');
    expect(notModified.headers.get("vary")).toBe("Accept");
    expect(notModified.headers.get("access-control-allow-origin")).toBe("*");

    const { env: blocked } = db(async () => ({ hit: 1 }));
    const card = await handleReadGate(
      new Request("https://embed.uploads.sh/acme/shot.png"),
      blocked,
      ctx(),
    );
    expect(card.headers.get("access-control-allow-origin")).toBe("*");
    expect(card.headers.get("cache-control")).toBe("no-store");
    await expectPlaceholder(card);
    const heldHead = await handleReadGate(
      new Request("https://store.uploads.sh/acme/shot.png", { method: "HEAD" }),
      blocked,
      ctx(),
    );
    expect(heldHead.status).toBe(200);
    expect(heldHead.headers.get("access-control-allow-origin")).toBe("*");
    expect((await heldHead.arrayBuffer()).byteLength).toBe(0);
    const other = await handleReadGate(
      new Request("https://storage.uploads.sh/acme/notes.pdf"),
      blocked,
      ctx(),
    );
    expect(other.status).toBe(404);
    expect(other.headers.get("access-control-allow-origin")).toBe("*");
    expect(other.headers.get("cache-control")).toBe("no-store");
    expect(await other.json()).toEqual({
      error: { code: "not_found", type: "not_found", message: "Not found." },
    });

    const posted = await handleReadGate(
      new Request("https://storage.uploads.sh/acme/open.png", { method: "POST" }),
      env,
      ctx(),
    );
    expect(posted.headers.get("access-control-allow-origin")).toBe("https://app.slack.com");
    vi.unstubAllGlobals();
  });

  it("leaves CORS on an unknown host to the origin", async () => {
    const origin = vi.fn(async (request: Request) => {
      expect(request.method).toBe("OPTIONS");
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", origin);
    const { env, calls } = db(async () => {
      throw new Error("lookup");
    });
    env.EXTRA_HOSTED_HOSTS = "read-gate-staging.uploads.sh";
    const extra = await handleReadGate(
      new Request("https://read-gate-staging.uploads.sh/acme/shot.png", {
        method: "OPTIONS",
        headers: { Origin: "https://docs.example", "Access-Control-Request-Method": "GET" },
      }),
      env,
      ctx(),
    );
    expect(extra.status).toBe(204);
    expect(extra.headers.get("access-control-allow-origin")).toBe("*");
    expect(origin).not.toHaveBeenCalled();

    const request = new Request("https://other.uploads.sh/acme/shot.png", { method: "OPTIONS" });
    const passed = await handleReadGate(request, env, ctx());
    expect(passed.status).toBe(204);
    expect(passed.headers.get("access-control-allow-origin")).toBeNull();
    expect(origin).toHaveBeenCalledOnce();
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
    await expectPlaceholder(gated);
    expect(origin).not.toHaveBeenCalled();

    const unknown = new Request("https://other.uploads.sh/acme/shot.avif");
    const passed = await handleReadGate(unknown, env, ctx());
    expect(passed.status).toBe(200);
    expect(passed.headers.get("cache-control")).toBeNull();
    expect(passed.headers.get("access-control-allow-origin")).toBeNull();
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
    const options = await handleReadGate(
      new Request("https://embed.uploads.sh/__read-gate/acme%2Fshot.png", { method: "OPTIONS" }),
      env,
      ctx(),
    );
    expect(options.status).toBe(404);
    expect(options.headers.get("access-control-allow-origin")).toBeNull();
    expect(origin).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("adds must-revalidate on an allowed read and keeps Range metadata", async () => {
    const origin = vi.fn(
      async () =>
        new Response("bytes", {
          status: 200,
          headers: {
            "cache-control": "public, max-age=60",
            etag: '"abc"',
            "content-type": "image/png",
            "accept-ranges": "bytes",
          },
        }),
    );
    vi.stubGlobal("fetch", origin);
    const { env } = db(async () => null);
    const direct = await handleReadGate(
      new Request("https://storage.uploads.sh/acme/shot.png"),
      env,
      ctx(),
    );
    const transformed = await handleReadGate(
      new Request("https://storage.uploads.sh/cdn-cgi/image/format=png/acme/shot.png"),
      env,
      ctx(),
    );
    expect(direct.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
    expect(transformed.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
    expect(direct.headers.get("etag")).toBe('"abc"');
    expect(direct.headers.get("content-type")).toBe("image/png");
    expect(direct.headers.get("accept-ranges")).toBe("bytes");
    expect(await direct.text()).toBe("bytes");
    expect(direct.status).toBe(200);
    vi.unstubAllGlobals();
  });

  it("leaves no-store and an existing must-revalidate response unchanged", () => {
    const noStore = new Response("embed", {
      headers: { "cache-control": "max-age=0, no-cache, no-store, must-revalidate", etag: '"e"' },
    });
    const already = new Response("ok", {
      headers: { "cache-control": "public, max-age=60, must-revalidate" },
    });
    const missing = new Response("plain");
    const ranged = new Response("x", {
      status: 206,
      headers: { "cache-control": "public, max-age=60", "content-range": "bytes 0-0/1" },
    });
    expect(withMustRevalidate(noStore)).toBe(noStore);
    expect(withMustRevalidate(already)).toBe(already);
    expect(withMustRevalidate(missing).headers.get("cache-control")).toBe(
      "public, max-age=60, must-revalidate",
    );
    const partial = withMustRevalidate(ranged);
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 0-0/1");
    expect(partial.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
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
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(lookups).toBe(1);
    expect(origin).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("serves the same card twice, an empty HEAD, and still 404s a held video or SVG", async () => {
    const origin = vi.fn(async () => new Response("bytes", { status: 200 }));
    vi.stubGlobal("fetch", origin);
    const { env } = db(async () => ({ hit: 1 }));
    const gate = ctx();
    const first = await handleReadGate(
      new Request("https://embed.uploads.sh/acme/Shot.JPEG?download=1"),
      env,
      gate,
    );
    const second = await handleReadGate(
      new Request("https://storage.uploads.sh/acme/Shot.JPEG"),
      env,
      gate,
    );
    await expectPlaceholder(first);
    await expectPlaceholder(second);
    const head = await handleReadGate(
      new Request("https://store.uploads.sh/acme/shot.png", { method: "HEAD" }),
      env,
      gate,
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("image/png");
    expect(head.headers.get("cache-control")).toBe("no-store");
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    for (const url of [
      "https://embed.uploads.sh/acme/clip.mp4",
      "https://embed.uploads.sh/acme/mark.svg",
    ]) {
      const response = await handleReadGate(new Request(url), env, gate);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.json()).toEqual({
        error: { code: "not_found", type: "not_found", message: "Not found." },
      });
    }
    expect(origin).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
