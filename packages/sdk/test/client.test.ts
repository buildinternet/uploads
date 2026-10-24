import { describe, expect, it, vi } from "vitest";
import { createUploadsClient, UploadsError, type RetryInfo } from "../src/index.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(...responses: Response[]) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  });
  return { calls, fetch: impl as unknown as typeof fetch };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const config = { token: "up_ws_secret", workspace: "ws", apiUrl: "https://api.test/" };

describe("createUploadsClient", () => {
  it("puts bytes to the encoded key with the token, type and metadata headers", async () => {
    const { calls, fetch } = fakeFetch(
      json(
        {
          workspace: "ws",
          key: "shots/a b.png",
          url: "https://cdn.test/shots/a%20b.png",
          size: 3,
          contentType: "image/png",
        },
        201,
      ),
    );
    const client = createUploadsClient(config, { fetch });

    const result = await client.put("shots/a b.png", new Uint8Array([1, 2, 3]), {
      contentType: "image/png",
      metadata: { path: "/settings", empty: "" },
    });

    expect(calls[0].url).toBe("https://api.test/v1/workspaces/ws/files/shots/a%20b.png");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer up_ws_secret");
    expect(headers["Content-Type"]).toBe("image/png");
    expect(headers["X-Uploads-Meta-path"]).toBe("/settings");
    expect(headers).not.toHaveProperty("X-Uploads-Meta-empty");
    expect(result).toMatchObject({ key: "shots/a b.png", embedUrl: null, replaced: false });
  });

  it("maps the error envelope to a typed UploadsError", async () => {
    const { fetch } = fakeFetch(
      json(
        {
          error: {
            code: "key_exists",
            message: "An object already exists.",
            details: { url: "https://cdn.test/a.png" },
          },
        },
        409,
      ),
    );
    const client = createUploadsClient(config, { fetch });

    const err = await client.put("a.png", new Uint8Array([1])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadsError);
    expect(err).toMatchObject({
      code: "KEY_EXISTS",
      status: 409,
      existingUrl: "https://cdn.test/a.png",
    });
  });

  it("retries a GET once on 503 and reports the retry", async () => {
    vi.useFakeTimers();
    try {
      const { calls, fetch } = fakeFetch(
        json({ error: "busy" }, 503, { "x-retry-after": "1" }),
        json({ items: [] }),
      );
      const retries: RetryInfo[] = [];
      const client = createUploadsClient(config, { fetch, onRetry: (info) => retries.push(info) });

      const pending = client.listHeld();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await pending).toEqual([]);
      expect(calls).toHaveLength(2);
      expect(retries).toEqual([{ reason: "responded 503", delayMs: 1_000 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never retries a put without an idempotency key", async () => {
    const { calls, fetch } = fakeFetch(json({ error: "busy" }, 503));
    const client = createUploadsClient(config, { fetch });

    await expect(client.put("a.png", new Uint8Array([1]))).rejects.toMatchObject({
      code: "API_ERROR",
      status: 503,
    });
    expect(calls).toHaveLength(1);
  });

  it("reports token expiry and sends no token to public endpoints", async () => {
    const onTokenExpiry = vi.fn();
    const { calls, fetch } = fakeFetch(
      json({ workspace: "ws" }, 200, { "Uploads-Token-Expires": "2026-12-01T00:00:00.000Z" }),
      json({ ok: true }),
    );
    const client = createUploadsClient(config, { fetch, onTokenExpiry });

    await client.usage();
    await client.health();

    expect(onTokenExpiry).toHaveBeenCalledWith("2026-12-01T00:00:00.000Z");
    expect(calls[1].url).toBe("https://api.test/health");
    expect(calls[1].init.headers).not.toHaveProperty("Authorization");
  });

  it("calls any route through request()", async () => {
    const { calls, fetch } = fakeFetch(json({ pulls: [] }));
    const client = createUploadsClient(config, { fetch });

    await client.request("GET", "/v1/workspaces/ws/pulls?state=open");

    expect(calls[0].url).toBe("https://api.test/v1/workspaces/ws/pulls?state=open");
  });
});
