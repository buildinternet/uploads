import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteWorkspaceFile,
  getGithubInstalled,
  getMyWorkspaces,
  getSuggestedWorkspaceName,
  getWorkspaceFacets,
  getWorkspaceFacetValues,
  getWorkspaceInvites,
  getWorkspaceMembers,
  inviteToWorkspace,
  listWorkspaceFolder,
  removeWorkspaceMember,
  revokeWorkspaceInvite,
  searchWorkspaceFiles,
  setFileVisibility,
  updateWorkspaceMemberRole,
} from "./api-client";

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

  it("parses the creation quota when the API sends one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ workspaces: [], workspaceCreate: { used: 3, cap: 3, allowed: false } }),
      ),
    );

    const result = await getMyWorkspaces("http://127.0.0.1:8787");
    expect(result).toMatchObject({ quota: { used: 3, cap: 3, allowed: false } });
  });

  it("leaves the quota undefined when the API omits or mangles it", async () => {
    for (const body of [
      { workspaces: [] },
      { workspaces: [], workspaceCreate: null },
      { workspaces: [], workspaceCreate: "nope" },
      { workspaces: [], workspaceCreate: { used: 3, cap: 3 } },
      { workspaces: [], workspaceCreate: { used: "3", cap: 3, allowed: false } },
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(body)),
      );
      const result = await getMyWorkspaces("http://127.0.0.1:8787");
      // Absent means allowed — a stale worker must never lock a user out.
      expect(result).toMatchObject({ kind: "success" });
      expect((result as { quota?: unknown }).quota).toBeUndefined();
    }
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
              hasPublicUrl: true,
            },
            {
              // Older api response, no hasPublicUrl field at all.
              workspace: "byo",
              organization: { id: "org2", slug: "byo", name: "BYO Inc" },
              role: "member",
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

  it("maps plan through and leaves it undefined when the API omits it (issue #365 follow-up)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          workspaces: [
            {
              workspace: "acme",
              organization: { id: "org1", slug: "acme", name: "Acme Inc" },
              role: "owner",
              plan: "pro",
            },
            {
              // Older api response, no plan field at all.
              workspace: "byo",
              organization: { id: "org2", slug: "byo", name: "BYO Inc" },
              role: "member",
            },
          ],
        }),
      ),
    );

    const result = await getMyWorkspaces("http://127.0.0.1:8787");
    expect(result.kind).toBe("success");
    if (result.kind !== "success") throw new Error("expected success");
    expect(result.workspaces.map((ws) => [ws.workspace, ws.plan])).toEqual([
      ["acme", "pro"],
      ["byo", undefined],
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

describe("deleteWorkspaceFile", () => {
  it("DELETEs with credentials and reports success", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "http://127.0.0.1:8787/me/workspaces/acme/files?key=f%2Fx%2Fshot.png",
      );
      expect(init?.method).toBe("DELETE");
      expect(init?.credentials).toBe("include");
      return Response.json({ key: "f/x/shot.png", deleted: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      deleteWorkspaceFile("http://127.0.0.1:8787", "acme", "f/x/shot.png"),
    ).resolves.toEqual({ kind: "success" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports non-2xx responses as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    await expect(deleteWorkspaceFile("http://127.0.0.1:8787", "acme", "a.png")).resolves.toEqual({
      kind: "unavailable",
      reason: "server",
    });
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

  it("reports a JSON null body as unavailable instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(null)),
    );
    await expect(
      searchWorkspaceFiles("http://127.0.0.1:8787", "acme", [{ key: "app", value: "web" }]),
    ).resolves.toEqual({ kind: "unavailable", reason: "malformed" });
  });
});

describe("getWorkspaceFacets", () => {
  it("returns keys from the facets route", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({
        keys: [{ key: "app", count: 2, distinctValues: 2 }],
        truncated: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await getWorkspaceFacets("https://api.test", "acme");
    expect(result).toEqual({
      kind: "ok",
      keys: [{ key: "app", count: 2, distinctValues: 2 }],
      truncated: false,
    });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.test/me/workspaces/acme/files/facets");
  });

  it("reports unavailable on a malformed body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ keys: "nope" })),
    );
    expect(await getWorkspaceFacets("https://api.test", "acme")).toEqual({ kind: "unavailable" });
  });

  it("reports unavailable on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    expect(await getWorkspaceFacets("https://api.test", "acme")).toEqual({ kind: "unavailable" });
  });

  it("reports a JSON null body as unavailable instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(null)),
    );
    expect(await getWorkspaceFacets("https://api.test", "acme")).toEqual({ kind: "unavailable" });
  });
});

describe("getWorkspaceFacetValues", () => {
  it("returns values from the facets route with a key filter", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({
        values: [{ value: "web", count: 3 }],
        truncated: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await getWorkspaceFacetValues("https://api.test", "acme", "app");
    expect(result).toEqual({
      kind: "ok",
      values: [{ value: "web", count: 3 }],
      truncated: false,
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.test/me/workspaces/acme/files/facets?key=app",
    );
  });

  it("encodes a key containing characters that need escaping (e.g. gh.repo)", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({ values: [], truncated: false }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await getWorkspaceFacetValues("https://api.test", "acme", "gh.repo");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.test/me/workspaces/acme/files/facets?key=gh.repo",
    );
  });

  it("encodes a key containing a slash and a space", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({ values: [], truncated: false }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await getWorkspaceFacetValues("https://api.test", "acme", "team/name here");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.test/me/workspaces/acme/files/facets?key=team%2Fname%20here",
    );
  });

  it("reports unavailable on a malformed body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ values: "nope" })),
    );
    expect(await getWorkspaceFacetValues("https://api.test", "acme", "app")).toEqual({
      kind: "unavailable",
    });
  });

  it("reports a JSON null body as unavailable instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(null)),
    );
    expect(await getWorkspaceFacetValues("https://api.test", "acme", "app")).toEqual({
      kind: "unavailable",
    });
  });

  it("reports unavailable on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    expect(await getWorkspaceFacetValues("https://api.test", "acme", "app")).toEqual({
      kind: "unavailable",
    });
  });
});

describe("searchWorkspaceFiles with a name term", () => {
  it("sends ?name= alongside meta filters", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({ items: [], truncated: false }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await searchWorkspaceFiles("https://api.test", "acme", [{ key: "app", value: "web" }], {
      name: "hero",
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.test/me/workspaces/acme/files/search?meta.app=web&name=hero",
    );
  });

  it("sends only ?name= when there are no filters", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({ items: [], truncated: false }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await searchWorkspaceFiles("https://api.test", "acme", [], { name: "hero" });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.test/me/workspaces/acme/files/search?name=hero",
    );
  });
});

describe("listWorkspaceFolder", () => {
  it("builds the querystring from opts, omitting absent params", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "http://127.0.0.1:8787/me/workspaces/acme/files?delimiter=%2F&prefix=f%2F&cursor=abc&limit=50",
      );
      expect(init?.credentials).toBe("include");
      return Response.json({ files: [], prefixes: [], cursor: null });
    });
    vi.stubGlobal("fetch", fetchMock);

    await listWorkspaceFolder("http://127.0.0.1:8787", "acme", {
      prefix: "f/",
      cursor: "abc",
      limit: 50,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("builds the querystring from a partial opts, omitting absent params", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("prefix=foo%2F");
      expect(url).toContain("delimiter=%2F");
      expect(url).not.toContain("cursor=");
      expect(url).not.toContain("limit=");
      return Response.json({ files: [], prefixes: [], cursor: null });
    });
    vi.stubGlobal("fetch", fetchMock);

    await listWorkspaceFolder("http://127.0.0.1:8787", "acme", { prefix: "foo/" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("still sends the folder delimiter when no opts are given", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("http://127.0.0.1:8787/me/workspaces/acme/files?delimiter=%2F");
      return Response.json({ files: [], prefixes: [], cursor: null });
    });
    vi.stubGlobal("fetch", fetchMock);

    await listWorkspaceFolder("http://127.0.0.1:8787", "acme");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("maps the JSON response through to WorkspaceFolderListing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          files: [
            {
              key: "f/x.png",
              url: "https://s/acme/f/x.png",
              embedUrl: "https://s/acme/f/x.png?embed",
              pageUrl: "https://uploads.sh/f/acme/f/x.png",
              size: 1024,
              contentType: "image/png",
              uploaded: "2026-07-19T00:00:00.000Z",
              visibility: "private",
              metadata: { "gh.repo": "acme/repo" },
            },
          ],
          prefixes: ["f/"],
          cursor: "next-cursor",
        }),
      ),
    );

    await expect(listWorkspaceFolder("http://127.0.0.1:8787", "acme")).resolves.toEqual({
      files: [
        {
          key: "f/x.png",
          url: "https://s/acme/f/x.png",
          embedUrl: "https://s/acme/f/x.png?embed",
          pageUrl: "https://uploads.sh/f/acme/f/x.png",
          size: 1024,
          contentType: "image/png",
          uploaded: "2026-07-19T00:00:00.000Z",
          visibility: "private",
          metadata: { "gh.repo": "acme/repo" },
        },
      ],
      prefixes: ["f/"],
      cursor: "next-cursor",
    });
  });

  it("omits pageUrl when the API leaves it off (BYO / no public base)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          files: [{ key: "f/x.png", url: null, embedUrl: null }],
          prefixes: [],
          cursor: null,
        }),
      ),
    );

    const result = await listWorkspaceFolder("http://127.0.0.1:8787", "acme");
    expect(result.files[0]?.pageUrl).toBeUndefined();
  });

  it("normalizes a null cursor to undefined", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ files: [], prefixes: [], cursor: null })),
    );

    const result = await listWorkspaceFolder("http://127.0.0.1:8787", "acme");
    expect(result.cursor).toBeUndefined();
  });

  it("passes a null url/embedUrl through as null rather than coercing to an empty string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          files: [{ key: "f/x.png", url: null, embedUrl: null }],
          prefixes: [],
          cursor: null,
        }),
      ),
    );

    const result = await listWorkspaceFolder("http://127.0.0.1:8787", "acme");
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.url).toBeNull();
    expect(result.files[0]?.embedUrl).toBeNull();
  });

  it("defaults prefixes to [] when the API omits it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ files: [], cursor: null })),
    );

    await expect(listWorkspaceFolder("http://127.0.0.1:8787", "acme")).resolves.toEqual({
      files: [],
      prefixes: [],
      cursor: undefined,
    });
  });

  it("degrades to an empty listing on a server error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );

    await expect(listWorkspaceFolder("http://127.0.0.1:8787", "acme")).resolves.toEqual({
      files: [],
      prefixes: [],
      cursor: undefined,
    });
  });

  it("degrades to an empty listing on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("network down"))),
    );

    await expect(listWorkspaceFolder("http://127.0.0.1:8787", "acme")).resolves.toEqual({
      files: [],
      prefixes: [],
      cursor: undefined,
    });
  });
});

describe("getWorkspaceMembers", () => {
  it("passes member id through when present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          members: [{ id: "m1", email: "a@x.com", name: "A", role: "member" }],
        }),
      ),
    );

    const result = await getWorkspaceMembers("http://127.0.0.1:8787", "acme");
    expect(result).toEqual({
      kind: "ok",
      members: [{ id: "m1", email: "a@x.com", name: "A", role: "member", createdAt: undefined }],
    });
  });

  it("leaves id undefined when the API omits it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          members: [{ email: "a@x.com", name: "A", role: "member" }],
        }),
      ),
    );

    const result = await getWorkspaceMembers("http://127.0.0.1:8787", "acme");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.members[0]?.id).toBeUndefined();
  });
});

describe("getWorkspaceInvites", () => {
  it("parses invites and passes id through to members", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          invites: [
            { id: "i1", email: "a@x.com", role: "member", status: "pending", expiresAt: 1 },
          ],
        }),
      ),
    );

    const res = await getWorkspaceInvites("https://api.test", "acme");
    expect(res).toMatchObject({ kind: "ok" });
    if (res.kind === "ok") expect(res.invites[0]?.id).toBe("i1");
  });

  it("reports unavailable on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );

    await expect(getWorkspaceInvites("https://api.test", "acme")).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("reports unavailable on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("network down"))),
    );

    await expect(getWorkspaceInvites("https://api.test", "acme")).resolves.toEqual({
      kind: "unavailable",
    });
  });
});

describe("manage mutations map status codes", () => {
  it("revokeWorkspaceInvite → forbidden on 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 403 })),
    );

    await expect(revokeWorkspaceInvite("https://api.test", "acme", "i1")).resolves.toEqual({
      kind: "unavailable",
      reason: "forbidden",
    });
  });

  it("removeWorkspaceMember → not_found on 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    await expect(removeWorkspaceMember("https://api.test", "acme", "m1")).resolves.toEqual({
      kind: "unavailable",
      reason: "not_found",
    });
  });

  it("updateWorkspaceMemberRole → invalid on 400", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 400 })),
    );

    await expect(
      updateWorkspaceMemberRole("https://api.test", "acme", "m1", "admin"),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "invalid",
    });
  });

  it("updateWorkspaceMemberRole → ok on 200, sending role in the PATCH body", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.test/me/workspaces/acme/members/m1");
      expect(init?.method).toBe("PATCH");
      expect(init?.credentials).toBe("include");
      expect(JSON.parse(init!.body as string)).toEqual({ role: "admin" });
      return Response.json({ member: { id: "m1", userId: "u2", role: "admin" } }, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateWorkspaceMemberRole("https://api.test", "acme", "m1", "admin"),
    ).resolves.toEqual({ kind: "ok" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("removeWorkspaceMember → ok on 200 via DELETE", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.test/me/workspaces/acme/members/m1");
      expect(init?.method).toBe("DELETE");
      expect(init?.credentials).toBe("include");
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(removeWorkspaceMember("https://api.test", "acme", "m1")).resolves.toEqual({
      kind: "ok",
    });
  });

  it("revokeWorkspaceInvite → unavailable(network) on transport failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("network down"))),
    );

    await expect(revokeWorkspaceInvite("https://api.test", "acme", "i1")).resolves.toEqual({
      kind: "unavailable",
      reason: "network",
    });
  });
});

describe("inviteToWorkspace", () => {
  it("distinguishes a member-cap denial from a plain authorization 403", async () => {
    const message = "Free workspaces include 3 members — upgrade to Pro for more.";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "member_cap_reached", message } }), {
            status: 403,
          }),
      ),
    );

    await expect(inviteToWorkspace("https://api.test", "acme", "new@example.com")).resolves.toEqual(
      { kind: "unavailable", reason: "member_cap", message },
    );
  });

  it("still reports a non-cap 403 as forbidden", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "inviter_not_authorized" } }), {
            status: 403,
          }),
      ),
    );

    await expect(inviteToWorkspace("https://api.test", "acme", "new@example.com")).resolves.toEqual(
      { kind: "unavailable", reason: "forbidden" },
    );
  });

  it("falls back to forbidden when the 403 body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 403 })),
    );

    await expect(inviteToWorkspace("https://api.test", "acme", "new@example.com")).resolves.toEqual(
      { kind: "unavailable", reason: "forbidden" },
    );
  });
});

describe("getGithubInstalled", () => {
  it("reports installed only on an explicit installed:true", async () => {
    let requested = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requested = url;
        return Response.json({ configured: true, installed: true, checkedRepos: 1 });
      }),
    );

    await expect(getGithubInstalled("https://api.test", "acme")).resolves.toBe(true);
    expect(requested).toBe("https://api.test/me/workspaces/acme/github-status");
  });

  it("keeps the CTA visible when the workspace has no install", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ configured: true, installed: false, checkedRepos: 0 })),
    );

    await expect(getGithubInstalled("https://api.test", "acme")).resolves.toBe(false);
  });

  it("degrades to shown on an outage, a non-2xx, and a malformed body", async () => {
    for (const stub of [
      vi.fn(async () => {
        throw new Error("network down");
      }),
      vi.fn(async () => new Response(null, { status: 503 })),
      vi.fn(async () => new Response("not json", { status: 200 })),
      vi.fn(async () => Response.json({ installed: "yes" })),
    ]) {
      vi.stubGlobal("fetch", stub);
      await expect(getGithubInstalled("https://api.test", "acme")).resolves.toBe(false);
    }
  });
});

describe("getSuggestedWorkspaceName", () => {
  it("returns the api's suggestion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ workspaces: [], suggestedWorkspace: "octocat" })),
    );
    expect(await getSuggestedWorkspaceName("http://127.0.0.1:8787")).toBe("octocat");
  });

  it("returns an empty string when the api offers nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ workspaces: [] })),
    );
    expect(await getSuggestedWorkspaceName("http://127.0.0.1:8787")).toBe("");
  });

  // Every failure collapses to "no prefill" — an empty field is the behavior
  // this feature replaced, so it is always a safe answer.
  it("returns an empty string on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    expect(await getSuggestedWorkspaceName("http://127.0.0.1:8787")).toBe("");
  });

  it("returns an empty string when the api is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(await getSuggestedWorkspaceName("http://127.0.0.1:8787")).toBe("");
  });
});
