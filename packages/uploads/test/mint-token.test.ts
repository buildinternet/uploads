import { afterEach, describe, expect, it, vi } from "vitest";
import { mintWorkspaceToken } from "../src/client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function okFetch() {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          token: "up_acme_x",
          workspace: "acme",
          scopes: ["files:read", "files:write"],
          label: null,
          expiresAt: null,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
  );
}

describe("mintWorkspaceToken idempotency", () => {
  it("sends Idempotency-Key when provided", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    await mintWorkspaceToken("https://api.test", "sess", {
      workspace: "acme",
      idempotencyKey: "mint-retry-1",
    });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("mint-retry-1");
  });

  it("omits Idempotency-Key when not provided", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    await mintWorkspaceToken("https://api.test", "sess", { workspace: "acme" });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).has("Idempotency-Key")).toBe(false);
  });
});
