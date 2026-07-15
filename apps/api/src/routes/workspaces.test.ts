import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { respondError } from "../error-response";
import { workspaces } from "./workspaces";

const USER = { id: "u1", email: "z@x.com", name: "Zach" };

interface EnvOpts {
  session?: boolean;
  githubLinked?: boolean;
  memberships?: { organizationId: string; organizationSlug: string; role: string }[];
  kvRecords?: Record<string, object>;
  provision?: () => { status: number; organization?: { id: string; slug: string; name: string } };
  onDeleteOrg?: (slug: string) => void;
  putThrows?: boolean;
  wsCreateLimiterAllows?: boolean;
}

function stubAuth(handler: (req: Request) => Response | Promise<Response>): Pick<Fetcher, "fetch"> {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return handler(req);
    }) as Fetcher["fetch"],
  };
}

function stubEnv(opts: EnvOpts = {}): Env {
  const {
    session = true,
    githubLinked = true,
    memberships = [],
    kvRecords = {},
    provision = () => ({
      status: 201,
      organization: { id: "org-1", slug: "zachbot", name: "zachbot" },
    }),
    onDeleteOrg,
    putThrows = false,
    wsCreateLimiterAllows,
  } = opts;

  const auth = stubAuth((req) => {
    const url = new URL(req.url);
    if (url.pathname === "/api/auth/get-session") {
      return new Response(JSON.stringify(session ? { session: {}, user: USER } : null), {
        status: 200,
      });
    }
    if (url.pathname === "/internal/users/u1/github-linked") {
      return new Response(JSON.stringify({ githubLinked }), { status: 200 });
    }
    if (url.pathname === "/internal/memberships") {
      return new Response(JSON.stringify(memberships), { status: 200 });
    }
    if (url.pathname === "/internal/orgs/provision") {
      const result = provision();
      if (result.status === 409) {
        return new Response(JSON.stringify({ error: {} }), { status: 409 });
      }
      return new Response(JSON.stringify({ organization: result.organization }), {
        status: result.status,
      });
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/internal/orgs/")) {
      onDeleteOrg?.(decodeURIComponent(url.pathname.slice("/internal/orgs/".length)));
      return new Response(null, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });

  const puts: [string, string][] = [];
  const registry = {
    get: (async (key: string) => {
      const name = key.startsWith("ws:") ? key.slice(3) : key;
      return kvRecords[name] ?? null;
    }) as unknown as KVNamespace["get"],
    put: (async (key: string, value: string) => {
      if (putThrows) throw new Error("kv put failed");
      puts.push([key, value]);
    }) as unknown as KVNamespace["put"],
  };

  const wsCreateLimiter =
    wsCreateLimiterAllows === undefined
      ? undefined
      : ({
          limit: (async () => ({ success: wsCreateLimiterAllows })) as unknown,
        } as unknown as Env["WS_CREATE_LIMITER"]);

  return Object.assign({ AUTH: auth, REGISTRY: registry, __puts: puts } as unknown as Env, {
    __puts: puts,
    ...(wsCreateLimiter ? { WS_CREATE_LIMITER: wsCreateLimiter } : {}),
  });
}

function app() {
  return new Hono<{ Bindings: Env }>()
    .route("/v1/workspaces", workspaces)
    .onError((err, c) => respondError(c, err));
}

function post(env: Env, body: unknown) {
  return app().request(
    "/v1/workspaces",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sess" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("POST /v1/workspaces", () => {
  it("401s with no session", async () => {
    const res = await post(stubEnv({ session: false }), { name: "zachbot" });
    expect(res.status).toBe(401);
  });

  it("400s on invalid and reserved names", async () => {
    const bad = await post(stubEnv(), { name: "Bad_Name" });
    expect(bad.status).toBe(400);
    expect((await bad.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_workspace_name" },
    });

    const reserved = await post(stubEnv(), { name: "admin" });
    expect(reserved.status).toBe(400);
    expect((await reserved.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "reserved_workspace_name" },
    });
  });

  it("403s code github_required when no GitHub account is linked", async () => {
    const res = await post(stubEnv({ githubLinked: false, wsCreateLimiterAllows: true }), {
      name: "zachbot",
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "github_required" },
    });
  });

  it("429s when the workspace-create limiter denies", async () => {
    const res = await post(stubEnv({ wsCreateLimiterAllows: false }), { name: "zachbot" });
    expect(res.status).toBe(429);
  });

  it("checks the create-rate-limit before the GitHub-linked gate", async () => {
    // Limiter denies AND GitHub isn't linked — rate limit must win, proving
    // the limiter check runs first and doesn't require the AUTH round-trip.
    const res = await post(stubEnv({ wsCreateLimiterAllows: false, githubLinked: false }), {
      name: "zachbot",
    });
    expect(res.status).toBe(429);
  });

  it("403s code workspace_cap_reached at 3 owned self-serve workspaces", async () => {
    const memberships = [
      { organizationId: "o1", organizationSlug: "one", role: "owner" },
      { organizationId: "o2", organizationSlug: "two", role: "owner" },
      { organizationId: "o3", organizationSlug: "three", role: "owner" },
    ];
    const kvRecords = {
      one: { selfServe: true },
      two: { selfServe: true },
      three: { selfServe: true },
    };
    const res = await post(stubEnv({ memberships, kvRecords }), { name: "zachbot" });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "workspace_cap_reached" },
    });
  });

  it("does not count non-self-serve (BYO) owned workspaces toward the cap", async () => {
    const memberships = [
      { organizationId: "o1", organizationSlug: "one", role: "owner" },
      { organizationId: "o2", organizationSlug: "two", role: "owner" },
      { organizationId: "o3", organizationSlug: "three", role: "owner" },
    ];
    const kvRecords = {
      one: { provider: "r2", bucket: "b" },
      two: { provider: "r2", bucket: "b" },
      three: { provider: "r2", bucket: "b" },
    };
    const res = await post(stubEnv({ memberships, kvRecords }), { name: "zachbot" });
    expect(res.status).toBe(201);
  });

  it("409s code workspace_name_taken when the KV record exists", async () => {
    const res = await post(stubEnv({ kvRecords: { zachbot: { provider: "r2", bucket: "b" } } }), {
      name: "zachbot",
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "workspace_name_taken" },
    });
  });

  it("409s code workspace_name_taken when org provisioning returns 409", async () => {
    const res = await post(stubEnv({ provision: () => ({ status: 409 }) }), { name: "zachbot" });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "workspace_name_taken" },
    });
  });

  it("creates org then KV record and returns 201", async () => {
    const env = stubEnv({
      provision: () => ({
        status: 201,
        organization: { id: "org-1", slug: "zachbot", name: "zachbot" },
      }),
    });
    const res = await post(env, { name: "zachbot" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workspace: { name: string; publicBaseUrl: string; selfServe: boolean };
    };
    expect(body.workspace).toEqual({
      name: "zachbot",
      publicBaseUrl: "https://storage.uploads.sh",
      selfServe: true,
    });

    const puts = (env as unknown as { __puts: [string, string][] }).__puts;
    expect(puts).toHaveLength(1);
    const [key, value] = puts[0];
    expect(key).toBe("ws:zachbot");
    const parsed = JSON.parse(value);
    expect(parsed).toMatchObject({
      selfServe: true,
      createdByUserId: "u1",
      prefix: "zachbot/",
      provider: "r2",
    });
    expect(parsed.createdAt).toBeTruthy();
  });

  it("rolls back the org when the KV write throws", async () => {
    let deletedSlug: string | undefined;
    const env = stubEnv({
      putThrows: true,
      onDeleteOrg: (slug) => {
        deletedSlug = slug;
      },
    });
    const res = await post(env, { name: "zachbot" });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(deletedSlug).toBe("zachbot");
  });
});
