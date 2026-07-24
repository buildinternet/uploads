import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { respondError } from "../error-response";
import { recordRepoLink } from "../github-repo-links";
import { me } from "./me";
import { FakeKv } from "../../test/fake-kv";
import { UsageFakeD1 } from "../../test/usage-fake-d1";
import { GITHUB_APP_CFG_ENV as CFG_ENV } from "../../test/github-app-env";

const USER = { id: "u-plain", email: "plain@b.com", name: "Plain", role: "user" };

/** Same membership/session scaffolding as github-titles-route.test.ts. */
function memberEnv({ member, kv, db }: { member: boolean; kv: FakeKv; db: UsageFakeD1 }): Env {
  const auth = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const { pathname } = new URL(req.url);
      if (pathname === "/api/auth/get-session") {
        return Response.json({ session: {}, user: USER });
      }
      if (pathname === "/internal/memberships") {
        return Response.json(
          member ? [{ organizationId: "org1", organizationSlug: "acme", role: "member" }] : [],
        );
      }
      if (pathname === "/internal/orgs/acme") {
        return Response.json({ organization: { id: "org1", slug: "acme", name: "Acme Inc" } });
      }
      return new Response(null, { status: 404 });
    }) as Fetcher["fetch"],
  };
  return { AUTH: auth, DB: db, GITHUB_CACHE: kv, ...CFG_ENV } as unknown as Env;
}

function app() {
  return new Hono<{ Bindings: Env }>().route("/me", me).onError((err, c) => respondError(c, err));
}

function request(env: Env) {
  return app().request("/me/workspaces/acme/github-status", { headers: { cookie: "s=1" } }, env);
}

describe("GET /me/workspaces/:name/github-status", () => {
  it("404s for a non-member workspace", async () => {
    const res = await request(
      memberEnv({ member: false, kv: new FakeKv(), db: new UsageFakeD1() }),
    );
    expect(res.status).toBe(404);
  });

  it("reports installed when a bound repo has the App", async () => {
    const db = new UsageFakeD1();
    await recordRepoLink(db as unknown as D1Database, "acme/web", "acme", "comment");
    const kv = new FakeKv();
    kv.store.set("ghinst:acme/web", { value: "42" });
    const res = await request(memberEnv({ member: true, kv, db }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: true, installed: true, checkedRepos: 1 });
  });

  it("reports not-installed for a workspace with no bindings", async () => {
    const res = await request(memberEnv({ member: true, kv: new FakeKv(), db: new UsageFakeD1() }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: true, installed: false, checkedRepos: 0 });
  });
});
