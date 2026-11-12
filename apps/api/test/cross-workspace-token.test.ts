/**
 * A personal token acts in every workspace its minting user belongs to
 * (workspace.ts `workspaceAuthWith`), and `/github/repo-link` names the
 * repo's workspace to a member so the CLI can upload there.
 */
import { describe, expect, it } from "vitest";
import { buildTokenRecord } from "../src/auth-db";
import { app } from "../src/index";
import {
  canActAcrossWorkspaces,
  resolveTokenWorkspace,
  sha256Hex,
  type WorkspaceRecord,
} from "../src/workspace";
import { Hono } from "hono";
import { isRepoCollaboratorRequest } from "../src/repo-collaborator";
import { UsageFakeD1 } from "./usage-fake-d1";
import { withMintingUserToken } from "./helpers/fake-minting-user-token";

if (typeof crypto.subtle.timingSafeEqual !== "function") {
  (
    crypto.subtle as unknown as { timingSafeEqual: (a: Uint8Array, b: Uint8Array) => boolean }
  ).timingSafeEqual = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);
}

const HOME = "home";
const OTHER = "relay";
const TOKEN = "up_home_crossworkspacetoken";
const REPO = "relay/site";

function record(name: string): WorkspaceRecord {
  return {
    provider: "r2",
    bucket: "b",
    binding: "UPLOADS_DEFAULT",
    prefix: `${name}/`,
    publicBaseUrl: "https://storage.uploads.sh",
    tokens: [],
  };
}

async function setup(opts: {
  memberOf: string[];
  owner?: "workspace";
  mintingUserId?: string | null;
  repoLinkedTo?: string;
  /** Seeds the cached GitHub write-access answer for user-1 on REPO. */
  canWrite?: boolean;
}) {
  const db = new UsageFakeD1();
  const tokenHash = await sha256Hex(TOKEN);
  const mintingUserId = opts.mintingUserId === undefined ? "user-1" : opts.mintingUserId;
  withMintingUserToken(db, { workspace: HOME, tokenHash, mintingUserId: mintingUserId ?? "" });
  if (opts.owner || mintingUserId === null) {
    // Reshape the row the helper returns: a service token, or no tracked user.
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const stmt = prepare(sql) as { bind: (...v: unknown[]) => { first: () => Promise<unknown> } };
      if (!sql.replace(/\s+/g, " ").trim().startsWith("SELECT id, workspace, token_hash")) {
        return stmt;
      }
      return {
        bind: (...v: unknown[]) => {
          const bound = stmt.bind(...v);
          return {
            ...bound,
            first: async () => {
              const row = (await bound.first()) as Record<string, unknown> | null;
              if (!row) return null;
              return {
                ...row,
                ...(opts.owner ? { owner: opts.owner, minting_user_id: null } : {}),
                ...(mintingUserId === null ? { minting_user_id: null } : {}),
              };
            },
          };
        },
      };
    }) as typeof db.prepare;
  }
  if (opts.repoLinkedTo) {
    db.repoLinks.set(REPO, {
      repo_full_name: REPO,
      workspace_name: opts.repoLinkedTo,
      installation_id: null,
      source: "comment",
      created_at: "2026-01-01T00:00:00.000Z",
    });
  }
  const membershipCalls: string[] = [];
  const env = {
    REGISTRY: {
      get: (async (key: string) =>
        key === `ws:${HOME}`
          ? record(HOME)
          : key === `ws:${OTHER}`
            ? record(OTHER)
            : null) as unknown as KVNamespace["get"],
    },
    DB: db,
    GITHUB_CACHE: {
      get: async (key: string) =>
        opts.canWrite !== undefined && key === `repo-write:${REPO}:user-1`
          ? opts.canWrite
            ? "1"
            : "0"
          : null,
      put: async () => undefined,
    },
    AUTH: {
      fetch: async (input: string) => {
        const url = new URL(input);
        if (url.pathname === "/internal/memberships") {
          const slug = url.searchParams.get("slug");
          membershipCalls.push(slug ?? "*");
          const slugs = opts.memberOf.filter((s) => !slug || s === slug);
          return Response.json(
            slugs.map((s) => ({
              organizationId: `org-${s}`,
              organizationSlug: s,
              organizationName: s,
              role: "member",
            })),
          );
        }
        return Response.json({ githubAccountId: null });
      },
    },
  } as unknown as Env;
  return { env, membershipCalls };
}

function repoLink(env: Env, workspace: string) {
  return app.request(
    `/v1/workspaces/${workspace}/github/repo-link?repo=${encodeURIComponent(REPO)}`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
    env,
  );
}

describe("personal tokens across workspaces", () => {
  it("acts in another workspace when the minting user is a member there", async () => {
    const { env } = await setup({ memberOf: [HOME, OTHER] });
    const res = await repoLink(env, OTHER);
    expect(res.status).toBe(200);
  });

  it("403s with workspace_access_denied when the user is not a member", async () => {
    const { env } = await setup({ memberOf: [HOME] });
    const res = await repoLink(env, OTHER);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "workspace_access_denied" } });
  });

  it("gives the same 403 for a workspace that doesn't exist", async () => {
    const { env } = await setup({ memberOf: [HOME] });
    const res = await repoLink(env, "nope");
    expect(res.status).toBe(403);
  });

  it("skips the membership lookup in the token's own workspace", async () => {
    const { env, membershipCalls } = await setup({ memberOf: [HOME] });
    const res = await repoLink(env, HOME);
    expect(res.status).toBe(200);
    expect(membershipCalls).toEqual([]);
  });

  it("keeps service tokens in their own workspace", async () => {
    const { env } = await setup({ memberOf: [HOME, OTHER], owner: "workspace" });
    expect((await repoLink(env, OTHER)).status).toBe(401);
  });

  it("keeps tokens with no tracked user in their own workspace", async () => {
    const { env } = await setup({ memberOf: [HOME, OTHER], mintingUserId: null });
    expect((await repoLink(env, OTHER)).status).toBe(401);
  });

  it("canActAcrossWorkspaces is personal tokens with a user only", () => {
    expect(canActAcrossWorkspaces({ owner: "member", minting_user_id: "u" })).toBe(true);
    expect(canActAcrossWorkspaces({ owner: "workspace", minting_user_id: null })).toBe(false);
    expect(canActAcrossWorkspaces({ owner: "member", minting_user_id: null })).toBe(false);
  });
});

describe("GET /github/repo-link names the owning workspace to members", () => {
  it("includes workspace when the caller is a member of it", async () => {
    const { env } = await setup({ memberOf: [HOME, OTHER], repoLinkedTo: OTHER });
    const res = await repoLink(env, HOME);
    expect(await res.json()).toEqual({ binding: "other", workspace: OTHER });
  });

  it("keeps the owner private from non-members", async () => {
    const { env } = await setup({ memberOf: [HOME], repoLinkedTo: OTHER });
    const res = await repoLink(env, HOME);
    expect(await res.json()).toEqual({ binding: "other" });
  });

  it("says self in the owning workspace", async () => {
    const { env } = await setup({ memberOf: [HOME, OTHER], repoLinkedTo: OTHER });
    const res = await repoLink(env, OTHER);
    expect(await res.json()).toEqual({ binding: "self" });
  });
});

describe("upk_ tokens", () => {
  it("mint without a workspace in the prefix when asked", async () => {
    const { token, record: row } = await buildTokenRecord({
      workspace: HOME,
      scopes: ["files:read"],
      mintedByUserId: "user-1",
      format: "upk",
    });
    expect(token.startsWith("upk_")).toBe(true);
    expect(token).not.toContain(HOME);
    expect(row.workspace).toBe(HOME);
  });

  it("keep the old prefix by default, and for service tokens", async () => {
    const personal = await buildTokenRecord({ workspace: HOME, scopes: ["files:read"] });
    expect(personal.token.startsWith(`up_${HOME}_`)).toBe(true);
    const service = await buildTokenRecord({
      workspace: HOME,
      scopes: ["files:read"],
      owner: "workspace",
      label: "ci",
      format: "upk",
    });
    expect(service.token.startsWith(`ups_${HOME}_`)).toBe(true);
  });
});

describe("resolveTokenWorkspace", () => {
  it("reads old prefixes without D1, and a upk_ token's workspace from its row", async () => {
    const db = new UsageFakeD1();
    const upk = "upk_abcdefghijklmnopqrstuvwx";
    withMintingUserToken(db, {
      workspace: HOME,
      tokenHash: await sha256Hex(upk),
      mintingUserId: "u",
    });
    const env = { DB: db } as unknown as Env;
    expect(await resolveTokenWorkspace(env, "up_acme_xyz")).toBe("acme");
    expect(await resolveTokenWorkspace(env, "ups_acme_xyz")).toBe("acme");
    expect(await resolveTokenWorkspace(env, upk)).toBe(HOME);
    expect(await resolveTokenWorkspace(env, "upk_unknown")).toBeUndefined();
  });
});

describe("GitHub collaborators who aren't members", () => {
  it("can make repo-scoped requests in the workspace the repo is linked to", async () => {
    const { env } = await setup({ memberOf: [HOME], repoLinkedTo: OTHER, canWrite: true });
    const res = await repoLink(env, OTHER);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ binding: "self" });
  });

  it("are refused without write access", async () => {
    const { env } = await setup({ memberOf: [HOME], repoLinkedTo: OTHER, canWrite: false });
    const res = await repoLink(env, OTHER);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "workspace_access_denied" } });
  });

  it("are refused when the repo is linked to a different workspace", async () => {
    const { env } = await setup({ memberOf: [HOME], repoLinkedTo: HOME, canWrite: true });
    expect((await repoLink(env, OTHER)).status).toBe(403);
  });

  it("are refused outside the repo's files", async () => {
    const { env } = await setup({ memberOf: [HOME], repoLinkedTo: OTHER, canWrite: true });
    const res = await app.request(
      `/v1/${OTHER}/files?prefix=${encodeURIComponent("gh/relay/other/")}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("learn the repo's workspace from the repo link", async () => {
    const { env } = await setup({ memberOf: [HOME], repoLinkedTo: OTHER, canWrite: true });
    const res = await repoLink(env, HOME);
    expect(await res.json()).toEqual({ binding: "other", workspace: OTHER });
  });
});

describe("isRepoCollaboratorRequest", () => {
  async function allowed(method: string, path: string, body?: unknown) {
    const { env } = await setup({ memberOf: [], repoLinkedTo: OTHER, canWrite: true });
    const probe = new Hono<{ Bindings: Env }>().all("*", async (c) =>
      c.json(await isRepoCollaboratorRequest(c, "user-1", OTHER)),
    );
    const res = await probe.request(
      path,
      body === undefined
        ? { method }
        : { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } },
      env,
    );
    return (await res.json()) as boolean;
  }

  it("allows the repo's files, comment, staging and galleries", async () => {
    expect(await allowed("PUT", `/v1/${OTHER}/files/gh/relay/site/pull/3/a.png`)).toBe(true);
    expect(await allowed("PUT", `/v1/workspaces/${OTHER}/files/gh/relay/site/branch/x/a.png`)).toBe(
      true,
    );
    expect(await allowed("GET", `/v1/${OTHER}/files?prefix=gh/relay/site/pull/3/`)).toBe(true);
    expect(await allowed("GET", `/v1/${OTHER}/files/held?prefix=gh/relay/site/`)).toBe(true);
    expect(await allowed("POST", `/v1/${OTHER}/github/comment`, { repo: REPO })).toBe(true);
    expect(await allowed("POST", `/v1/${OTHER}/github/promote`, { repo: REPO })).toBe(true);
    expect(
      await allowed(
        "GET",
        `/v1/${OTHER}/galleries/by-reference?provider=github&coordinate=${encodeURIComponent(`${REPO}#3`)}`,
      ),
    ).toBe(true);
  });

  it("refuses everything else", async () => {
    expect(await allowed("PUT", `/v1/${OTHER}/files/gh/relay/other/pull/3/a.png`)).toBe(false);
    expect(await allowed("PUT", `/v1/${OTHER}/files/gh/relay/site/../x/a.png`)).toBe(false);
    expect(await allowed("PUT", `/v1/${OTHER}/files/f/abc/a.png`)).toBe(false);
    expect(await allowed("DELETE", `/v1/${OTHER}/files/gh/relay/site/pull/3/a.png`)).toBe(false);
    expect(await allowed("GET", `/v1/${OTHER}/files`)).toBe(false);
    expect(await allowed("POST", `/v1/${OTHER}/github/attach`, { repo: REPO })).toBe(false);
    expect(await allowed("POST", `/v1/${OTHER}/github/comment`, { repo: "relay/other" })).toBe(
      false,
    );
    expect(await allowed("GET", `/v1/${OTHER}/galleries`)).toBe(false);
    expect(await allowed("PUT", `/v1/${HOME}/files/gh/relay/site/pull/3/a.png`)).toBe(false);
  });
});
