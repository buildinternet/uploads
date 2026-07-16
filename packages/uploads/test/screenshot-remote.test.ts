import { describe, expect, it } from "vitest";
import { UploadsError } from "../src/errors.js";
import { captureRemote, MAX_REMOTE_HTML_BYTES } from "../src/screenshot-remote.js";

function fakeFetch(handler: (input: unknown, init?: RequestInit) => Response) {
  return (async (input: unknown, init?: RequestInit) => handler(input, init)) as typeof fetch;
}

describe("captureRemote", () => {
  it("resolves with raw PNG bytes on a 200 response", async () => {
    const png = new Uint8Array([1, 2, 3, 4]);
    let seenUrl: string | undefined;
    let seenAuth: string | null | undefined;
    const fetchImpl = fakeFetch((input, init) => {
      seenUrl = String(input);
      seenAuth = (init?.headers as Record<string, string> | undefined)?.authorization;
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    });

    const bytes = await captureRemote(
      { url: "https://example.com", viewport: { width: 1280, height: 800, deviceScaleFactor: 2 } },
      { apiUrl: "https://api.uploads.sh", token: "up_default_test", fetchImpl },
    );

    expect(seenUrl).toBe("https://api.uploads.sh/v1/render");
    expect(seenAuth).toBe("Bearer up_default_test");
    expect(new Uint8Array(bytes)).toEqual(png);
  });

  it("maps render_failed to RENDER_FAILED", async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ error: { message: "render timed out", code: "render_failed" } }),
          {
            status: 502,
          },
        ),
    );
    await expect(
      captureRemote(
        {
          url: "https://example.com",
          viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
        },
        { apiUrl: "https://api.uploads.sh", token: "t", fetchImpl },
      ),
    ).rejects.toMatchObject({ code: "RENDER_FAILED" });
  });

  it("maps upload_budget_exceeded (429) to the existing UPLOAD_BUDGET code", async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            error: { message: "monthly upload budget exceeded", code: "upload_budget_exceeded" },
          }),
          { status: 429 },
        ),
    );
    await expect(
      captureRemote(
        {
          url: "https://example.com",
          viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
        },
        { apiUrl: "https://api.uploads.sh", token: "t", fetchImpl },
      ),
    ).rejects.toMatchObject({ code: "UPLOAD_BUDGET", status: 429 });
  });

  it("maps the server's rate_limited code to RATE_LIMITED", async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ error: { message: "too many renders", code: "rate_limited" } }),
          { status: 429 },
        ),
    );
    await expect(
      captureRemote(
        {
          url: "https://example.com",
          viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
        },
        { apiUrl: "https://api.uploads.sh", token: "t", fetchImpl },
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
  });

  it("maps a bare 429 (no body code) to RATE_LIMITED — a throttle is more likely than a budget denial", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({}), { status: 429 }));
    await expect(
      captureRemote(
        {
          url: "https://example.com",
          viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
        },
        { apiUrl: "https://api.uploads.sh", token: "t", fetchImpl },
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("maps 401 to UNAUTHORIZED", async () => {
    const fetchImpl = fakeFetch(
      () => new Response(JSON.stringify({ error: { message: "bad token" } }), { status: 401 }),
    );
    await expect(
      captureRemote(
        {
          url: "https://example.com",
          viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
        },
        { apiUrl: "https://api.uploads.sh", token: "t", fetchImpl },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
  });

  it("rejects an oversized html body before making any request", async () => {
    let called = false;
    const fetchImpl = fakeFetch(() => {
      called = true;
      return new Response(null, { status: 200 });
    });
    const html = "x".repeat(MAX_REMOTE_HTML_BYTES + 1);
    await expect(
      captureRemote(
        { html, viewport: { width: 1280, height: 800, deviceScaleFactor: 2 } },
        { apiUrl: "https://api.uploads.sh", token: "t", fetchImpl },
      ),
    ).rejects.toBeInstanceOf(UploadsError);
    expect(called).toBe(false);
  });

  it("maps a network failure to NETWORK", async () => {
    const fetchImpl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as typeof fetch;
    await expect(
      captureRemote(
        {
          url: "https://example.com",
          viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
        },
        { apiUrl: "https://api.uploads.sh", token: "t", fetchImpl },
      ),
    ).rejects.toMatchObject({ code: "NETWORK" });
  });
});
