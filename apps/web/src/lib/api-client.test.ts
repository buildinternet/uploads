import { afterEach, describe, expect, it, vi } from "vitest";
import { getMyWorkspaces, searchWorkspaceFiles, setFileVisibility } from "./api-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getMyWorkspaces", () => {
  it("preserves a successful empty workspace list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ workspaces: [] })),
    );

    await expect(getMyWorkspaces("http://127.0.0.1:8787")).resolves.toEqual({
      kind: "success",
      workspaces: [],
    });
  });

  it("does not render an API outage as an empty account", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );

    await expect(getMyWorkspaces("http://127.0.0.1:8787")).resolves.toEqual({
      kind: "unavailable",
      reason: "server",
    });
  });

  it("reports malformed workspace responses as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ notWorkspaces: [] })),
    );

    await expect(getMyWorkspaces("http://127.0.0.1:8787")).resolves.toEqual({
      kind: "unavailable",
      reason: "malformed",
    });
  });

  it("propagates network failures instead of rendering an empty account", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("network down"))),
    );

    await expect(getMyWorkspaces("http://127.0.0.1:8787")).resolves.toEqual({
      kind: "unavailable",
      reason: "network",
    });
  });

  it("maps hasPublicUrl through and defaults it false when the API omits it (issue #123)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          workspaces: [
            {
              workspace: "acme",
              organization: { id: "org1", slug: "acme", name: "Acme Inc" },
              role: "owner",
              communal: false,
              hasPublicUrl: true,
            },
            {
              // Older api response, no hasPublicUrl field at all.
              workspace: "byo",
              organization: { id: "org2", slug: "byo", name: "BYO Inc" },
              role: "member",
              communal: false,
            },
          ],
        }),
      ),
    );

    const result = await getMyWorkspaces("http://127.0.0.1:8787");
    expect(result.kind).toBe("success");
    if (result.kind !== "success") throw new Error("expected success");
    expect(result.workspaces.map((ws) => [ws.workspace, ws.hasPublicUrl])).toEqual([
      ["acme", true],
      ["byo", false],
    ]);
  });
});

describe("setFileVisibility", () => {
  it("PATCHes with credentials and returns the resulting visibility", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "http://127.0.0.1:8787/me/workspaces/acme/files/visibility?key=f%2Fx%2Fshot.png",
      );
      expect(init?.method).toBe("PATCH");
      expect(init?.credentials).toBe("include");
      expect(JSON.parse(init!.body as string)).toEqual({ visibility: "private" });
      return Response.json({ key: "f/x/shot.png", visibility: "private" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      setFileVisibility("http://127.0.0.1:8787", "acme", "f/x/shot.png", "private"),
    ).resolves.toEqual({ kind: "success", visibility: "private" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports non-2xx responses as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    await expect(
      setFileVisibility("http://127.0.0.1:8787", "acme", "a.png", "public"),
    ).resolves.toEqual({ kind: "unavailable", reason: "server" });
  });

  it("reports a malformed body as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ key: "a.png" })),
    );

    await expect(
      setFileVisibility("http://127.0.0.1:8787", "acme", "a.png", "public"),
    ).resolves.toEqual({ kind: "unavailable", reason: "malformed" });
  });

  it("propagates network failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("network down"))),
    );

    await expect(
      setFileVisibility("http://127.0.0.1:8787", "acme", "a.png", "public"),
    ).resolves.toEqual({ kind: "unavailable", reason: "network" });
  });
});

describe("searchWorkspaceFiles", () => {
  it("returns matching items and the truncated flag", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          items: [
            {
              key: "f/x.png",
              url: "https://s/acme/f/x.png",
              embedUrl: null,
              metadata: { app: "web" },
            },
          ],
          truncated: true,
        }),
      ),
    );
    await expect(
      searchWorkspaceFiles("http://127.0.0.1:8787", "acme", [{ key: "app", value: "web" }]),
    ).resolves.toEqual({
      kind: "ok",
      items: [
        { key: "f/x.png", url: "https://s/acme/f/x.png", embedUrl: null, metadata: { app: "web" } },
      ],
      truncated: true,
    });
  });

  it("reports a server error as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    await expect(
      searchWorkspaceFiles("http://127.0.0.1:8787", "acme", [{ key: "app", value: "web" }]),
    ).resolves.toEqual({ kind: "unavailable", reason: "server" });
  });

  it("reports a malformed body as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ nope: true })),
    );
    await expect(
      searchWorkspaceFiles("http://127.0.0.1:8787", "acme", [{ key: "app", value: "web" }]),
    ).resolves.toEqual({ kind: "unavailable", reason: "malformed" });
  });
});
