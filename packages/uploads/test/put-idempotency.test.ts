import { afterEach, describe, expect, it, vi } from "vitest";
import { createUploadsClient } from "../src/client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function client() {
  return createUploadsClient({
    apiUrl: "https://api.test",
    workspace: "test",
    token: "up_test_x",
  });
}

function okFetch() {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          workspace: "test",
          key: "a.png",
          url: "https://cdn.test/a.png",
          size: 3,
          contentType: "image/png",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
  );
}

describe("put idempotency (issue #829)", () => {
  it("sends Idempotency-Key when provided", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await client().put(new Uint8Array([1, 2, 3]), {
      filename: "a.png",
      key: "a.png",
      idempotencyKey: "upload-retry-1",
    });

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("upload-retry-1");
  });

  it("omits Idempotency-Key when not provided", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await client().put(new Uint8Array([1, 2, 3]), {
      filename: "a.png",
      key: "a.png",
    });

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).has("Idempotency-Key")).toBe(false);
  });
});
