import { describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "@uploads/errors";
import {
  deleteOrg,
  invitesForOrg,
  listOrgs,
  orgForWorkspace,
  removeMember,
  revokeInvite,
  updateMemberRole,
  workspacesForOrg,
} from "./org-workspaces";

/** Stub matching the Fetcher interface's `.fetch()` shape used by env.AUTH. */
function stubAuth(handler: (req: Request) => Response | Promise<Response>): Pick<Fetcher, "fetch"> {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return handler(req);
    }) as Fetcher["fetch"],
  };
}

function envWith(auth: Pick<Fetcher, "fetch">): Env {
  return { AUTH: auth } as unknown as Env;
}

describe("orgForWorkspace", () => {
  it("resolves the org for a known workspace slug, calling the internal endpoint", async () => {
    const auth = stubAuth((req) => {
      expect(req.url).toBe("https://auth.internal/internal/orgs/acme");
      expect(req.headers.get("x-uploads-internal")).toBe("1");
      return new Response(
        JSON.stringify({ organization: { id: "org1", slug: "acme", name: "Acme" } }),
        { status: 200 },
      );
    });
    const result = await orgForWorkspace(envWith(auth), "acme");
    expect(result).toEqual({ id: "org1", slug: "acme", name: "Acme" });
  });

  it("returns null for a 404 (no org provisioned for this workspace yet)", async () => {
    const auth = stubAuth(() => new Response(null, { status: 404 }));
    const result = await orgForWorkspace(envWith(auth), "no-such-workspace");
    expect(result).toBeNull();
  });

  it("throws on a non-2xx, non-404 response instead of masquerading as org_not_found", async () => {
    const auth = stubAuth(() => new Response(null, { status: 500 }));
    await expect(orgForWorkspace(envWith(auth), "acme")).rejects.toThrow();
  });

  it("URL-encodes the workspace name", async () => {
    const auth = stubAuth((req) => {
      expect(req.url).toBe("https://auth.internal/internal/orgs/has%20space");
      return new Response(null, { status: 404 });
    });
    await orgForWorkspace(envWith(auth), "has space");
  });
});

describe("workspacesForOrg", () => {
  it("returns the 1:1 workspace (the org's slug) as a single-element array", async () => {
    const auth = stubAuth(() =>
      Response.json({ organization: { id: "org1", slug: "acme", name: "Acme" } }),
    );
    const result = await workspacesForOrg(envWith(auth), "acme");
    expect(result).toEqual(["acme"]);
  });

  it("returns an empty array when the org doesn't exist", async () => {
    const auth = stubAuth(() => new Response(null, { status: 404 }));
    const result = await workspacesForOrg(envWith(auth), "unknown");
    expect(result).toEqual([]);
  });
});

describe("listOrgs (#250 orphan sweep)", () => {
  it("returns the organizations array from GET /internal/orgs", async () => {
    const auth = stubAuth((req) => {
      expect(req.url).toBe("https://auth.internal/internal/orgs");
      return Response.json({
        organizations: [
          { id: "o1", slug: "acme" },
          { id: "o2", slug: "widgets" },
        ],
      });
    });
    const result = await listOrgs(envWith(auth));
    expect(result).toEqual([
      { id: "o1", slug: "acme" },
      { id: "o2", slug: "widgets" },
    ]);
  });

  it("throws on a non-ok response instead of masquerading as an empty list", async () => {
    const auth = stubAuth(() => new Response(null, { status: 500 }));
    await expect(listOrgs(envWith(auth))).rejects.toThrow();
  });

  it("throws on a malformed body", async () => {
    const auth = stubAuth(() => Response.json({ nope: true }));
    await expect(listOrgs(envWith(auth))).rejects.toThrow();
  });
});

describe("deleteOrg force flag (#250)", () => {
  it("without force: no query string", async () => {
    const auth = stubAuth((req) => {
      expect(req.url).toBe("https://auth.internal/internal/orgs/acme");
      return new Response(null, { status: 200 });
    });
    await deleteOrg(envWith(auth), "acme");
  });

  it("with force: true, appends ?force=1", async () => {
    const auth = stubAuth((req) => {
      expect(req.url).toBe("https://auth.internal/internal/orgs/acme?force=1");
      return new Response(null, { status: 200 });
    });
    await deleteOrg(envWith(auth), "acme", { force: true });
  });
});

describe("invitesForOrg", () => {
  it("returns the invites array", async () => {
    const auth = stubAuth((req) => {
      expect(req.url).toBe("https://auth.internal/internal/orgs/acme/invites");
      return Response.json({
        invites: [{ id: "i1", email: "a@x.com", role: "member", status: "pending", expiresAt: 1 }],
      });
    });
    expect(await invitesForOrg(envWith(auth), "acme")).toEqual([
      { id: "i1", email: "a@x.com", role: "member", status: "pending", expiresAt: 1 },
    ]);
  });

  it("throws ServiceUnavailable on a non-ok response", async () => {
    const auth = stubAuth(() => new Response("nope", { status: 500 }));
    await expect(invitesForOrg(envWith(auth), "acme")).rejects.toThrow();
  });
});

describe("revokeInvite / removeMember / updateMemberRole error mapping", () => {
  it("revokeInvite maps 404 to NotFoundError", async () => {
    const auth = stubAuth((req) => {
      expect(req.url).toBe("https://auth.internal/internal/orgs/acme/invites/i1?actorUserId=u1");
      expect(req.method).toBe("DELETE");
      return Response.json({ error: { code: "invite_not_found" } }, { status: 404 });
    });
    await expect(revokeInvite(envWith(auth), "acme", "i1", "u1")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("removeMember maps 403 to ForbiddenError", async () => {
    const auth = stubAuth((req) => {
      expect(req.url).toBe("https://auth.internal/internal/orgs/acme/members/m1?actorUserId=u1");
      expect(req.method).toBe("DELETE");
      return Response.json({ error: { code: "actor_not_authorized" } }, { status: 403 });
    });
    await expect(removeMember(envWith(auth), "acme", "m1", "u1")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("updateMemberRole returns the updated member on 200", async () => {
    const auth = stubAuth((req) => {
      expect(req.url).toBe("https://auth.internal/internal/orgs/acme/members/m1");
      expect(req.method).toBe("PATCH");
      expect(req.headers.get("content-type")).toBe("application/json");
      return Response.json({ member: { id: "m1", userId: "u2", role: "admin" } });
    });
    expect(await updateMemberRole(envWith(auth), "acme", "m1", "admin", "u1")).toEqual({
      id: "m1",
      userId: "u2",
      role: "admin",
    });
  });

  it("updateMemberRole maps 400 to a thrown error", async () => {
    const auth = stubAuth(() =>
      Response.json({ error: { code: "invalid_role" } }, { status: 400 }),
    );
    await expect(updateMemberRole(envWith(auth), "acme", "m1", "owner", "u1")).rejects.toThrow();
  });
});
