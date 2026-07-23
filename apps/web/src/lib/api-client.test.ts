import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getMyWorkspaces,
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
