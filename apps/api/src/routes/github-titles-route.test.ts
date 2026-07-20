import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { respondError } from "../error-response";
import { me } from "./me";
import { FakeKv } from "../../test/fake-kv";
import { UsageFakeD1 } from "../../test/usage-fake-d1";
import { GITHUB_APP_CFG_ENV as CFG_ENV } from "../../test/github-app-env";

const USER = { id: "u-plain", email: "plain@b.com", name: "Plain", role: "user" };

function stubAuth(handler: (req: Request) => Response | Promise<Response>): Pick<Fetcher, "fetch"> {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return handler(req);
    }) as Fetcher["fetch"],
  };
}

/** A single stub that answers get-session with `user`, and everything else via `onInternal`. */
function stubEnv(
  user: typeof USER | null,
  onInternal: (path: string, req: Request) => Response | Promise<Response>,
  db: unknown = new UsageFakeD1(),
): Env {
  const auth = stubAuth((req) => {
    const url = new URL(req.url);
    if (url.pathname === "/api/auth/get-session") {
      return new Response(JSON.stringify(user ? { session: {}, user } : null), { status: 200 });
    }
    return onInternal(url.pathname, req);
  });
  return { AUTH: auth, DB: db, REGISTRY: fakeKv({}) } as unknown as Env;
}

function fakeKv(records: Record<string, unknown>): Pick<KVNamespace, "get"> {
  return {
    get: (async (key: string) =>
      key in records ? records[key] : null) as unknown as KVNamespace["get"],
  };
}

/**
 * Adapted from me.test.ts's stubEnv/membership scaffolding: USER is a member
 * of workspace "acme" when `member` is true, and env is merged with
 * GITHUB_CACHE + the three GITHUB_APP_* vars resolveTitles needs.
 */
function memberEnv({ member, kv }: { member: boolean; kv: FakeKv }): Env {
  const env = stubEnv(USER, (path) => {
    if (path === "/internal/memberships") {
      return Response.json(
        member ? [{ organizationId: "org1", organizationSlug: "acme", role: "member" }] : [],
      );
    }
    if (path === "/internal/orgs/acme") {
      return Response.json({ organization: { id: "org1", slug: "acme", name: "Acme Inc" } });
    }
    return new Response(null, { status: 404 });
  });
  return { ...env, ...CFG_ENV, GITHUB_CACHE: kv } as unknown as Env;
}

function app() {
  return new Hono<{ Bindings: Env }>().route("/me", me).onError((err, c) => respondError(c, err));
}

describe("GET /me/workspaces/:name/github-titles", () => {
  it("404s for a non-member workspace", async () => {
    const env = memberEnv({ member: false, kv: new FakeKv() });
    const res = await app().request(
      "/me/workspaces/acme/github-titles?refs=o/r%231",
      { headers: { cookie: "s=1" } },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("400s on missing refs, an invalid ref, and more than 20 refs", async () => {
    const env = memberEnv({ member: true, kv: new FakeKv() });
    for (const qs of [
      "",
      "?refs=",
      "?refs=not-a-ref",
      `?refs=${Array.from({ length: 21 }, (_, i) => `o/r%23${i + 1}`).join(",")}`,
    ]) {
      const res = await app().request(
        `/me/workspaces/acme/github-titles${qs}`,
        { headers: { cookie: "s=1" } },
        env,
      );
      expect(res.status).toBe(400);
    }
  });

  it("returns cached titles keyed by normalized ref, null for misses", async () => {
    const kv = new FakeKv();
    kv.store.set("ghref:o/r#1", {
      value: JSON.stringify({ v: { title: "Ship it", state: "open", kind: "pull" } }),
    });
    kv.store.set("ghref:o/r#2", { value: JSON.stringify({ v: null }) });
    const env = memberEnv({ member: true, kv });
    const res = await app().request(
      "/me/workspaces/acme/github-titles?refs=O/R%231,o/r%232",
      { headers: { cookie: "s=1" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      refs: {
        "o/r#1": { title: "Ship it", state: "open", kind: "pull" },
        "o/r#2": null,
      },
    });
  });
});
