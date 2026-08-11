import { describe, expect, it, vi } from "vitest";
import { createUploadsClient } from "../src/client.js";

describe("resolveGhPrefix (issue #631)", () => {
  it("POSTs { repo, target } to /v1/:workspace/github/private-prefix and returns the result", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          mode: "private",
          prefixId: "a".repeat(32),
          activePrefixIds: ["a".repeat(32)],
        }),
        { status: 200 },
      ),
    );
    const client = createUploadsClient({
      apiUrl: "https://api.test",
      workspace: "acme",
      token: "tok",
    });
    const res = await client.resolveGhPrefix({
      repo: "acme/web",
      target: { kind: "pull", num: 12 },
    });
    expect(res).toEqual({
      mode: "private",
      prefixId: "a".repeat(32),
      activePrefixIds: ["a".repeat(32)],
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.test/v1/acme/github/private-prefix");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))).toEqual({
      repo: "acme/web",
      target: { kind: "pull", num: 12 },
    });
    fetchSpy.mockRestore();
  });

  it("resolves to { mode: 'plain' } on a 404 (older/self-hosted server) without throwing", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("not found", { status: 404 }));
    const client = createUploadsClient({
      apiUrl: "https://api.test",
      workspace: "acme",
      token: "tok",
    });
    await expect(client.resolveGhPrefix({ repo: "acme/web" })).resolves.toEqual({
      mode: "plain",
    });
    fetchSpy.mockRestore();
  });

  it("resolves to { mode: 'plain' } on a network error without throwing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const client = createUploadsClient({
      apiUrl: "https://api.test",
      workspace: "acme",
      token: "tok",
    });
    await expect(client.resolveGhPrefix({ repo: "acme/web" })).resolves.toEqual({
      mode: "plain",
    });
    fetchSpy.mockRestore();
  });

  it("caches per repo+branch+target — a second call for the same coordinate does not re-fetch", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ mode: "plain" }), { status: 200 }));
    const client = createUploadsClient({
      apiUrl: "https://api.test",
      workspace: "acme",
      token: "tok",
    });
    const opts = { repo: "acme/web", target: { kind: "pull" as const, num: 12 } };
    await client.resolveGhPrefix(opts);
    await client.resolveGhPrefix(opts);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it("a different repo+branch+target coordinate is not cache-hit by another", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ mode: "plain" }), { status: 200 }));
    const client = createUploadsClient({
      apiUrl: "https://api.test",
      workspace: "acme",
      token: "tok",
    });
    await client.resolveGhPrefix({ repo: "acme/web", target: { kind: "pull", num: 12 } });
    await client.resolveGhPrefix({ repo: "acme/web", target: { kind: "pull", num: 13 } });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
  });
});
