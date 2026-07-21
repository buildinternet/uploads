# Device Login Workspace Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move workspace selection for `uploads login` from the CLI to the `/device` approval page, so approval can never report success for a workspace the user cannot access.

**Architecture:** The CLI declares its requested workspace in the RFC 8628 device-code `scope` field. better-auth stores that string on the `device_code` row and echoes it back to the CLI at token exchange, so a new auth-worker plugin can rewrite it at approval time and the CLI reads the browser's decision out of the token response. The `/device` page grows a picker (with inline workspace creation) plus a blocking "no access" state.

**Tech Stack:** Cloudflare Workers, Hono, better-auth 1.6.23 (`deviceAuthorization` plugin), drizzle-orm/d1, Astro (apps/web), vitest.

Design doc: `docs/superpowers/specs/2026-07-21-device-login-workspace-selection-design.md`. Issue: #362.

## Global Constraints

- `apps/auth` has **no direct `zod` dependency** (only transitive). Validate endpoint input by hand — do not add zod. See the comment in `apps/auth/src/workspace-choice.ts`.
- `packages/uploads` ships with **no workspace dependencies** (`dependencies` are `exif-reader` + `sharp` only). It cannot import from `apps/*` or other `packages/*`. Scope parsing is duplicated there deliberately, with a comment cross-referencing the auth copy.
- The device scope vocabulary is exactly: `workspace:<slug>` and `create`, space-separated. `<slug>` matches `[a-z0-9][a-z0-9-]{1,62}`.
- **A surviving `create` token in the echoed scope means the browser deferred to the CLI.** When the approval page records a choice it writes `workspace:<slug>` with no `create`. This is the CLI's signal for which side decided.
- `user_code` is stored **hyphen-stripped** in `device_code.user_code` (better-auth's routes call `user_code.replace(/-/g, "")`). Every lookup must strip hyphens first.
- Never distinguish "workspace does not exist" from "you are not a member" in user-facing copy — `apps/api/src/routes/tokens.ts:167-177` deliberately collapses both into one 403, and the page copy must match.
- Commit messages: conventional commits, no words like "comprehensive" or "world-class".
- Test commands: `pnpm test:auth`, `pnpm test:cli`, `pnpm test:web` for a single package; `pnpm test` for the whole suite. `pnpm typecheck` before finishing.

---

### Task 1: Auth worker — `deviceWorkspacePlugin`

**Files:**

- Create: `apps/auth/src/device-workspace.ts`
- Create: `apps/auth/src/device-workspace.test.ts`
- Modify: `apps/auth/src/auth.ts` (plugin registration, next to `workspaceChoicePlugin(db)` at line ~550)

**Interfaces:**

- Consumes: `apps/auth/src/schema.ts`'s `deviceCode`, `member`, `organization` tables; the fake-D1 harness at `apps/auth/src/test/fake-d1.ts`.
- Produces:
  - `parseDeviceScope(scope: string | null | undefined): { workspace: string | null; create: boolean }`
  - `workspaceScopeValue(slug: string): string`
  - `deviceWorkspacePlugin(db: Db)` — a better-auth plugin exposing `GET /device/workspace?user_code=…` → `{ requested: string | null, create: boolean, workspaces: { slug: string; name: string }[] }` and `POST /device/workspace` `{ userCode, workspace }` → `{ status: true }`. Full paths under the worker's `/api/auth` basePath are `/api/auth/device/workspace`.

- [ ] **Step 1: Write the failing test**

Create `apps/auth/src/device-workspace.test.ts`:

```ts
/**
 * Issue #362 (auth side): the `/device/workspace` read + write endpoints that
 * let the approval page resolve and record which workspace a device login
 * mints for. Driven against the real Better Auth handler via src/index.ts's
 * `app` on the fake-D1 harness, same pattern as device.test.ts /
 * workspace-choice.test.ts.
 */
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { AuthEnv } from "./auth";
import { parseDeviceScope, workspaceScopeValue } from "./device-workspace";
import { app } from "./index";
import * as schema from "./schema";
import { createFakeD1 } from "./test/fake-d1";

function dbEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
  return {
    DB: createFakeD1(),
    WEB_ORIGIN: "https://uploads.sh",
    BETTER_AUTH_URL: "https://auth.uploads.sh",
    ENVIRONMENT: "development",
    BETTER_AUTH_SECRET_DEV: "test-signing-secret-at-least-32-chars-long",
    ...overrides,
  };
}

/** Seed a user + active session + org memberships; returns the raw bearer token. */
async function seedSignedInUser(
  env: AuthEnv,
  orgSlugs: { slug: string; createdAt: Date }[] = [],
): Promise<{ userId: string; sessionToken: string }> {
  const orm = drizzle(env.DB, { schema });
  const userId = crypto.randomUUID();
  await orm.insert(schema.user).values({
    id: userId,
    name: "Ada Lovelace",
    email: `ada-${userId}@example.com`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    role: "user",
  });
  const sessionToken = `sess-${crypto.randomUUID()}`;
  await orm.insert(schema.session).values({
    id: crypto.randomUUID(),
    userId,
    token: sessionToken,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  for (const { slug, createdAt } of orgSlugs) {
    const orgId = crypto.randomUUID();
    await orm.insert(schema.organization).values({ id: orgId, name: slug, slug, createdAt });
    await orm.insert(schema.member).values({
      id: crypto.randomUUID(),
      organizationId: orgId,
      userId,
      role: "member",
      createdAt,
    });
  }
  return { userId, sessionToken };
}

/** Insert a device_code row directly — the plugin's own /device/code is exercised in device.test.ts. */
async function seedDeviceCode(
  env: AuthEnv,
  over: Partial<{
    userCode: string;
    scope: string | null;
    status: string;
    userId: string | null;
    expiresAt: Date;
  }> = {},
): Promise<string> {
  const orm = drizzle(env.DB, { schema });
  const userCode = over.userCode ?? "ABCDEFGH";
  await orm.insert(schema.deviceCode).values({
    id: crypto.randomUUID(),
    deviceCode: `dev-${crypto.randomUUID()}`,
    userCode,
    userId: over.userId ?? null,
    expiresAt: over.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000),
    status: over.status ?? "pending",
    clientId: "uploads-cli",
    scope: over.scope ?? null,
  });
  return userCode;
}

function getWorkspace(env: AuthEnv, userCode: string, sessionToken?: string) {
  return app.request(
    `/api/auth/device/workspace?user_code=${encodeURIComponent(userCode)}`,
    { headers: { ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}) } },
    env,
  );
}

function postWorkspace(env: AuthEnv, body: unknown, sessionToken?: string) {
  return app.request(
    "/api/auth/device/workspace",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("parseDeviceScope", () => {
  it("reads the workspace and create tokens in any order", () => {
    expect(parseDeviceScope("workspace:acme")).toEqual({ workspace: "acme", create: false });
    expect(parseDeviceScope("workspace:acme create")).toEqual({ workspace: "acme", create: true });
    expect(parseDeviceScope("create workspace:acme")).toEqual({ workspace: "acme", create: true });
  });

  it("treats absent, empty, and unrelated scopes as no request", () => {
    expect(parseDeviceScope(null)).toEqual({ workspace: null, create: false });
    expect(parseDeviceScope("")).toEqual({ workspace: null, create: false });
    expect(parseDeviceScope("files:read files:write")).toEqual({ workspace: null, create: false });
    expect(parseDeviceScope("workspace:")).toEqual({ workspace: null, create: false });
  });
});

describe("workspaceScopeValue", () => {
  it("never carries create — a recorded choice always means the browser decided", () => {
    expect(workspaceScopeValue("acme")).toBe("workspace:acme");
  });
});

describe("GET /device/workspace", () => {
  it("401s when unauthenticated", async () => {
    const env = dbEnv();
    const userCode = await seedDeviceCode(env);
    expect((await getWorkspace(env, userCode)).status).toBe(401);
  });

  it("returns the requested workspace and the caller's memberships", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env, [
      { slug: "acme", createdAt: new Date("2026-01-01T00:00:00Z") },
      { slug: "beta", createdAt: new Date("2026-02-01T00:00:00Z") },
    ]);
    const userCode = await seedDeviceCode(env, { scope: "workspace:default" });

    const res = await getWorkspace(env, userCode, sessionToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      requested: "default",
      create: false,
      workspaces: [
        { slug: "acme", name: "acme" },
        { slug: "beta", name: "beta" },
      ],
    });
  });

  it("accepts a hyphenated user code and reports no request when scope is empty", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env);
    await seedDeviceCode(env, { userCode: "ABCDEFGH" });

    const res = await getWorkspace(env, "ABCD-EFGH", sessionToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requested: null, create: false, workspaces: [] });
  });

  it("400s for an unknown user code", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env);
    const res = await getWorkspace(env, "ZZZZZZZZ", sessionToken);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("invalid_user_code");
  });

  it("400s for an expired row", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env);
    const userCode = await seedDeviceCode(env, { expiresAt: new Date(Date.now() - 1000) });
    const res = await getWorkspace(env, userCode, sessionToken);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("expired_user_code");
  });

  it("403s when the row was already claimed by another user", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env);
    const userCode = await seedDeviceCode(env, { userId: "someone-else" });
    const res = await getWorkspace(env, userCode, sessionToken);
    expect(res.status).toBe(403);
  });
});

describe("POST /device/workspace", () => {
  it("401s when unauthenticated", async () => {
    const env = dbEnv();
    const userCode = await seedDeviceCode(env);
    expect((await postWorkspace(env, { userCode, workspace: "acme" })).status).toBe(401);
  });

  it("writes workspace:<slug> onto the row for a valid membership", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env, [
      { slug: "acme", createdAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    const userCode = await seedDeviceCode(env, { scope: "workspace:acme create" });

    const res = await postWorkspace(env, { userCode, workspace: "acme" }, sessionToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: true });

    const orm = drizzle(env.DB, { schema });
    const [row] = await orm
      .select()
      .from(schema.deviceCode)
      .where(eq(schema.deviceCode.userCode, userCode));
    // `create` is dropped: a recorded choice always means the browser decided.
    expect(row?.scope).toBe("workspace:acme");
  });

  it("400s invalid_workspace for a non-membership slug", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env, [
      { slug: "acme", createdAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    const userCode = await seedDeviceCode(env);
    const res = await postWorkspace(env, { userCode, workspace: "default" }, sessionToken);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("invalid_workspace");
  });

  it("400s invalid_workspace for a malformed body", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env, [
      { slug: "acme", createdAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    const userCode = await seedDeviceCode(env);
    const res = await postWorkspace(env, { userCode }, sessionToken);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("invalid_workspace");
  });

  it("400s once the row is no longer pending", async () => {
    const env = dbEnv();
    const { sessionToken } = await seedSignedInUser(env, [
      { slug: "acme", createdAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    const userCode = await seedDeviceCode(env, { status: "approved" });
    const res = await postWorkspace(env, { userCode, workspace: "acme" }, sessionToken);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("device_code_already_processed");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:auth -- device-workspace`
Expected: FAIL — `Failed to resolve import "./device-workspace"`.

- [ ] **Step 3: Write the implementation**

Create `apps/auth/src/device-workspace.ts`:

```ts
/**
 * Device-login workspace selection (issue #362). The `/device` approval page
 * needs to know which workspace the terminal asked for — and be able to change
 * it — BEFORE it approves, so it can never show "you're signed in" for a
 * workspace the user has no access to.
 *
 * The channel is the device-code `scope` column. better-auth's
 * `deviceAuthorization` plugin stores whatever `POST /device/code` sent and
 * echoes it back to the client in the token response (`scope:
 * claimedDeviceCode.scope || ""`), so a value written here reaches the CLI at
 * exchange with no extra table and no extra round trip. Ordering is safe by
 * construction: the CLI cannot receive a token before the row is `approved`,
 * and the page writes the choice strictly before calling `/device/approve`.
 *
 * `parseDeviceScope` is mirrored in packages/uploads/src/commands/login.ts —
 * that package ships with no workspace dependencies, so the two copies are
 * deliberately independent. Keep the vocabulary in sync.
 *
 * The picker UI lives on apps/web's /device page; this file is only the
 * auth-side plumbing (pattern: src/workspace-choice.ts).
 */
import { createAuthEndpoint, sessionMiddleware, APIError } from "better-auth/api";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

/** Scope token carrying the requested workspace, e.g. `workspace:acme`. */
export const WORKSPACE_SCOPE_PREFIX = "workspace:";
/** Scope token meaning "the CLI will provision this workspace after login" (`uploads login --create`). */
export const CREATE_SCOPE_TOKEN = "create";

type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DeviceScope {
  workspace: string | null;
  create: boolean;
}

/** Read the workspace request out of a device-code scope string. Order-insensitive; unknown tokens ignored. */
export function parseDeviceScope(scope: string | null | undefined): DeviceScope {
  const tokens = (scope ?? "").split(/\s+/).filter(Boolean);
  const slug =
    tokens
      .find((t) => t.startsWith(WORKSPACE_SCOPE_PREFIX))
      ?.slice(WORKSPACE_SCOPE_PREFIX.length) ?? "";
  return { workspace: slug || null, create: tokens.includes(CREATE_SCOPE_TOKEN) };
}

/**
 * The scope value written when the browser records a choice. Deliberately
 * never includes `create`: a surviving `create` token is exactly how the CLI
 * tells "the browser decided" from "the browser deferred to me".
 */
export function workspaceScopeValue(slug: string): string {
  return `${WORKSPACE_SCOPE_PREFIX}${slug}`;
}

/**
 * `member` ⋈ `organization` for a user, oldest membership first. Same join and
 * ordering as `membershipSlugs` in src/workspace-choice.ts, kept separate
 * because this one needs display names too.
 */
async function memberships(db: Db, userId: string): Promise<{ slug: string; name: string }[]> {
  return db
    .select({ slug: schema.organization.slug, name: schema.organization.name })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
    .where(eq(schema.member.userId, userId))
    .orderBy(asc(schema.member.createdAt), asc(schema.member.id));
}

/**
 * Load a device-code row that this user may act on: it must exist, be
 * unexpired, still be `pending`, and be unclaimed or claimed by the caller —
 * the same conditions better-auth's own `/device/approve` enforces. Unlike the
 * plugin's `GET /device`, this never claims the row's `userId`.
 */
async function loadActionableRow(db: Db, rawUserCode: unknown, userId: string) {
  if (typeof rawUserCode !== "string" || rawUserCode.length === 0) {
    throw new APIError("BAD_REQUEST", {
      code: "invalid_user_code",
      message: "`user_code` is required.",
    });
  }
  // Stored hyphen-stripped by the plugin's own routes.
  const userCode = rawUserCode.replace(/-/g, "");
  const [row] = await db
    .select()
    .from(schema.deviceCode)
    .where(eq(schema.deviceCode.userCode, userCode))
    .limit(1);
  if (!row) {
    throw new APIError("BAD_REQUEST", {
      code: "invalid_user_code",
      message: "That code is invalid or has expired.",
    });
  }
  if (row.expiresAt.getTime() < Date.now()) {
    throw new APIError("BAD_REQUEST", {
      code: "expired_user_code",
      message: "That code has expired.",
    });
  }
  if (row.status !== "pending") {
    throw new APIError("BAD_REQUEST", {
      code: "device_code_already_processed",
      message: "That request was already approved or denied.",
    });
  }
  if (row.userId && row.userId !== userId) {
    throw new APIError("FORBIDDEN", {
      code: "device_code_claimed",
      message: "That request belongs to another account.",
    });
  }
  return row;
}

export function deviceWorkspacePlugin(db: Db) {
  return {
    id: "uploads-device-workspace",
    endpoints: {
      /**
       * `GET /device/workspace?user_code=…` — what the terminal asked for plus
       * the workspaces the signed-in user can actually pick. The page turns
       * this into its panel state (apps/web/src/lib/device-workspace.ts).
       */
      deviceWorkspaceGet: createAuthEndpoint(
        "/device/workspace",
        { method: "GET", use: [sessionMiddleware] },
        async (ctx) => {
          const userId = ctx.context.session.user.id;
          // better-call always populates ctx.query from the URL's search
          // params, with or without a declared query schema — so no zod here
          // (apps/auth has no direct zod dependency).
          const row = await loadActionableRow(
            db,
            (ctx.query as { user_code?: unknown } | undefined)?.user_code,
            userId,
          );
          const { workspace, create } = parseDeviceScope(row.scope);
          return ctx.json({
            requested: workspace,
            create,
            workspaces: await memberships(db, userId),
          });
        },
      ),
      /**
       * `POST /device/workspace` `{ userCode, workspace }` — record the
       * workspace this device login should mint for. Validates the slug
       * against the caller's own memberships; a non-membership slug 400s
       * rather than recording a workspace the user can't use (same contract as
       * POST /oauth2/workspace-choice).
       */
      deviceWorkspaceSet: createAuthEndpoint(
        "/device/workspace",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const userId = ctx.context.session.user.id;
          const body = ctx.body as { userCode?: unknown; workspace?: unknown } | undefined;
          const workspace = typeof body?.workspace === "string" ? body.workspace : "";
          if (!workspace) {
            throw new APIError("BAD_REQUEST", {
              code: "invalid_workspace",
              message: "`workspace` must be a non-empty string.",
            });
          }
          const row = await loadActionableRow(db, body?.userCode, userId);

          const slugs = (await memberships(db, userId)).map((w) => w.slug);
          if (!slugs.includes(workspace)) {
            throw new APIError("BAD_REQUEST", {
              code: "invalid_workspace",
              message: "You are not a member of that workspace.",
            });
          }

          await db
            .update(schema.deviceCode)
            .set({ scope: workspaceScopeValue(workspace) })
            .where(eq(schema.deviceCode.id, row.id));

          return ctx.json({ status: true });
        },
      ),
    },
  };
}
```

- [ ] **Step 4: Register the plugin**

In `apps/auth/src/auth.ts`, add the import next to the existing `workspace-choice` import block (~line 27):

```ts
import { deviceWorkspacePlugin } from "./device-workspace";
```

and register it immediately after `workspaceChoicePlugin(db),` (~line 550):

```ts
      workspaceChoicePlugin(db),
      // Issue #362: GET/POST /device/workspace, letting the /device approval
      // page resolve and rewrite the workspace a device login mints for
      // before it approves.
      deviceWorkspacePlugin(db),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:auth -- device-workspace`
Expected: PASS, all cases green.

- [ ] **Step 6: Run the full auth suite for regressions**

Run: `pnpm test:auth`
Expected: PASS — `device.test.ts` in particular must still pass (the plugin registration must not disturb the existing device flow).

- [ ] **Step 7: Commit**

```bash
git add apps/auth/src/device-workspace.ts apps/auth/src/device-workspace.test.ts apps/auth/src/auth.ts
git commit -m "feat(auth): device-login workspace read/write endpoints (#362)"
```

---

### Task 2: CLI — send and read the workspace scope

**Files:**

- Modify: `packages/uploads/src/client.ts:458-470` (`requestDeviceCode`)
- Modify: `packages/uploads/src/commands/login.ts` (scope helpers, `pollForDeviceToken`, `obtainDeviceAccessToken`, `runDeviceLogin`)
- Test: `packages/uploads/test/commands-login.test.ts`

**Interfaces:**

- Consumes: Task 1's scope vocabulary (`workspace:<slug>`, `create`) — the wire contract only, not its code.
- Produces:
  - `parseDeviceScope(scope: string | undefined): { workspace: string | undefined; create: boolean }` (exported from `commands/login.ts`)
  - `formatDeviceScope(workspace: string | undefined, create: boolean): string | undefined`
  - `interface DeviceSession { accessToken: string; scope: string }`
  - `pollForDeviceToken(authUrl, code, io): Promise<DeviceSession>` (return type change)
  - `obtainDeviceSession(authUrl, opts: { noOpen?: boolean; prompt?: string; scope?: string }, io): Promise<DeviceSession>`
  - `obtainDeviceAccessToken(...)` keeps returning `Promise<string>` — `commands/invite.ts:98` depends on that.

- [ ] **Step 1: Write the failing tests**

Add to `packages/uploads/test/commands-login.test.ts`. First extend the import from `../src/commands/login.js` with the new symbols:

```ts
import {
  formatDeviceScope,
  parseDeviceScope,
  resolveAuthUrl,
  resolveEnrollmentCode,
  runLogin,
  validateEnrollmentCode,
  type DeviceLoginIo,
} from "../src/commands/login.js";
```

Then append these blocks:

```ts
describe("device scope vocabulary", () => {
  it("formats only when a workspace was requested", () => {
    expect(formatDeviceScope(undefined, false)).toBeUndefined();
    expect(formatDeviceScope(undefined, true)).toBeUndefined();
    expect(formatDeviceScope("acme", false)).toBe("workspace:acme");
    expect(formatDeviceScope("acme", true)).toBe("workspace:acme create");
  });

  it("round-trips through parse", () => {
    expect(parseDeviceScope(formatDeviceScope("acme", true))).toEqual({
      workspace: "acme",
      create: true,
    });
    expect(parseDeviceScope("workspace:acme")).toEqual({ workspace: "acme", create: false });
    expect(parseDeviceScope("")).toEqual({ workspace: undefined, create: false });
    expect(parseDeviceScope(undefined)).toEqual({ workspace: undefined, create: false });
  });
});

describe("runLogin device flow — browser workspace selection", () => {
  const silentIo: DeviceLoginIo = {
    sleep: async () => {},
    now: () => Date.now(),
    openUrl: () => {},
    write: () => {},
    isTTY: false,
    promptWorkspaceName: async () => "",
  };

  const deviceCode = (over: Record<string, unknown> = {}) =>
    response({
      device_code: "dev-123",
      user_code: "ABCD-EFGH",
      verification_uri: "https://uploads.sh/device",
      verification_uri_complete: "https://uploads.sh/device?user_code=ABCD-EFGH",
      expires_in: 900,
      interval: 5,
      ...over,
    });

  it("sends the requested workspace as a device-code scope", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    const token = "up_acme_abcdefghijklmnopqrstuvwxyz";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(deviceCode())
      .mockResolvedValueOnce(
        response({
          access_token: "sess-tok",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "workspace:acme",
        }),
      )
      .mockResolvedValueOnce(
        response(
          { token, workspace: "acme", scopes: ["files:read"], label: "host", expiresAt: null },
          201,
        ),
      );
    captureOutput();

    expect(
      await runLogin(
        ["--path", path, "--workspace", "acme", "--no-check"],
        { json: true },
        false,
        silentIo,
      ),
    ).toBe(0);

    const codeCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/device/code"));
    expect(JSON.parse(String((codeCall![1] as RequestInit).body))).toMatchObject({
      client_id: "uploads-cli",
      scope: "workspace:acme",
    });
  });

  it("mints for the workspace the browser chose, overriding --workspace", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    const token = "up_beta_abcdefghijklmnopqrstuvwxyz";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(deviceCode())
      .mockResolvedValueOnce(
        response({
          access_token: "sess-tok",
          token_type: "Bearer",
          expires_in: 3600,
          // The approval page rewrote the row: the user picked `beta`.
          scope: "workspace:beta",
        }),
      )
      .mockResolvedValueOnce(
        response(
          { token, workspace: "beta", scopes: ["files:read"], label: "host", expiresAt: null },
          201,
        ),
      );
    captureOutput();

    expect(
      await runLogin(
        ["--path", path, "--workspace", "acme", "--no-check"],
        { json: true },
        false,
        silentIo,
      ),
    ).toBe(0);

    const mintCall = fetchMock.mock.calls.find(
      (c) => String(c[0]).endsWith("/v1/tokens") && (c[1] as RequestInit)?.method === "POST",
    );
    expect(JSON.parse(String((mintCall![1] as RequestInit).body))).toMatchObject({
      grants: [{ workspace: "beta" }],
    });
    expect(loadConfigFile(path).UPLOADS_WORKSPACE).toBe("beta");
  });

  it("mints for the browser's choice with no --workspace and several memberships", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    const token = "up_beta_abcdefghijklmnopqrstuvwxyz";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(deviceCode())
      .mockResolvedValueOnce(
        response({
          access_token: "sess-tok",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "workspace:beta",
        }),
      )
      .mockResolvedValueOnce(
        response(
          { token, workspace: "beta", scopes: ["files:read"], label: "host", expiresAt: null },
          201,
        ),
      );
    captureOutput();

    // No --workspace: this used to hard-error for multi-workspace accounts.
    expect(await runLogin(["--path", path, "--no-check"], { json: true }, false, silentIo)).toBe(0);
    // The browser answered, so no GET /v1/tokens listing was needed.
    expect(
      fetchMock.mock.calls.some(
        (c) => String(c[0]).endsWith("/v1/tokens") && (c[1] as RequestInit)?.method !== "POST",
      ),
    ).toBe(false);
  });

  it("keeps the CLI provisioning path when the echoed scope still carries create", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    const token = "up_fresh_abcdefghijklmnopqrstuvwxyz";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(deviceCode())
      .mockResolvedValueOnce(
        response({
          access_token: "sess-tok",
          token_type: "Bearer",
          expires_in: 3600,
          // Unchanged by the page: it deferred to the CLI (--create).
          scope: "workspace:fresh create",
        }),
      )
      .mockResolvedValueOnce(response({ workspaces: [] })) // GET /v1/tokens
      .mockResolvedValueOnce(
        response(
          {
            workspace: {
              name: "fresh",
              publicBaseUrl: "https://storage.uploads.sh/fresh",
              selfServe: true,
            },
          },
          201,
        ),
      ) // POST /v1/workspaces
      .mockResolvedValueOnce(
        response(
          { token, workspace: "fresh", scopes: ["files:read"], label: "host", expiresAt: null },
          201,
        ),
      );
    captureOutput();

    expect(
      await runLogin(
        ["--path", path, "--workspace", "fresh", "--create", "--no-check"],
        { json: true },
        false,
        silentIo,
      ),
    ).toBe(0);
    expect(loadConfigFile(path).UPLOADS_WORKSPACE).toBe("fresh");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:cli -- commands-login`
Expected: FAIL — `formatDeviceScope`/`parseDeviceScope` are not exported; the scope-override cases mint for the wrong workspace.

- [ ] **Step 3: Add the scope parameter to `requestDeviceCode`**

In `packages/uploads/src/client.ts`, replace the existing `requestDeviceCode` (lines 458-470):

```ts
export function requestDeviceCode(
  authUrl: string,
  clientId = DEVICE_CLIENT_ID,
  /**
   * RFC 8628 `scope`. Carries the requested workspace (`workspace:<slug>`,
   * plus `create`) so the approval page can validate it before approving —
   * issue #362. Stored on the device-code row and echoed back at token
   * exchange, possibly rewritten by the page.
   */
  scope?: string,
): Promise<DeviceCodeResponse> {
  return jsonRequest(`${authUrl.replace(/\/$/, "")}/api/auth/device/code`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": cliUserAgent("device-code"),
    },
    body: JSON.stringify({ client_id: clientId, ...(scope ? { scope } : {}) }),
  });
}
```

- [ ] **Step 4: Add the scope helpers to `commands/login.ts`**

Insert after the `validateEnrollmentCode` function (~line 63):

```ts
/**
 * Device-code scope vocabulary (issue #362). Mirrors `parseDeviceScope` /
 * `workspaceScopeValue` in apps/auth/src/device-workspace.ts — this package
 * ships with no workspace dependencies, so the two copies are deliberately
 * independent. Keep the vocabulary in sync.
 */
const WORKSPACE_SCOPE_PREFIX = "workspace:";
const CREATE_SCOPE_TOKEN = "create";

/** The scope the CLI sends with its device-code request. No workspace requested → no scope. */
export function formatDeviceScope(
  workspace: string | undefined,
  create: boolean,
): string | undefined {
  if (!workspace) return undefined;
  return create
    ? `${WORKSPACE_SCOPE_PREFIX}${workspace} ${CREATE_SCOPE_TOKEN}`
    : `${WORKSPACE_SCOPE_PREFIX}${workspace}`;
}

/**
 * Read back what the approval page decided. A surviving `create` token means
 * the page left the scope alone and deferred provisioning to the CLI; a bare
 * `workspace:<slug>` means the browser recorded a choice and wins.
 */
export function parseDeviceScope(scope: string | undefined): {
  workspace: string | undefined;
  create: boolean;
} {
  const tokens = (scope ?? "").split(/\s+/).filter(Boolean);
  const slug =
    tokens
      .find((t) => t.startsWith(WORKSPACE_SCOPE_PREFIX))
      ?.slice(WORKSPACE_SCOPE_PREFIX.length) ?? "";
  return { workspace: slug || undefined, create: tokens.includes(CREATE_SCOPE_TOKEN) };
}
```

- [ ] **Step 5: Return the scope from the poll and the session helper**

In `packages/uploads/src/commands/login.ts`, replace `obtainDeviceAccessToken` (lines 212-228) with:

```ts
/** A completed device authorization: the session bearer plus the (possibly rewritten) scope. */
export interface DeviceSession {
  accessToken: string;
  scope: string;
}

/**
 * Browser device-authorization session only (no workspace token mint).
 * Shared by `uploads login` and `uploads invite create`.
 */
export async function obtainDeviceSession(
  authUrl: string,
  opts: { noOpen?: boolean; prompt?: string; scope?: string } = {},
  io: DeviceLoginIo = defaultDeviceIo,
): Promise<DeviceSession> {
  const code = await requestDeviceCode(authUrl, undefined, opts.scope);
  const verifyUrl = code.verification_uri_complete ?? code.verification_uri;
  const prompt = opts.prompt ?? "To sign in, open:";
  io.write(`${prompt}\n\n  ${verifyUrl}\n\nand confirm this code:\n\n  ${code.user_code}\n\n`);
  if (!opts.noOpen) io.openUrl(verifyUrl);
  io.write("Waiting for approval…\n");
  return pollForDeviceToken(authUrl, code, io);
}

/** Session bearer only — `invite create` has no workspace to resolve. */
export async function obtainDeviceAccessToken(
  authUrl: string,
  opts: { noOpen?: boolean; prompt?: string } = {},
  io: DeviceLoginIo = defaultDeviceIo,
): Promise<string> {
  return (await obtainDeviceSession(authUrl, opts, io)).accessToken;
}
```

Note `requestDeviceCode(authUrl, undefined, opts.scope)` — the middle argument keeps its `DEVICE_CLIENT_ID` default.

Then change `pollForDeviceToken`'s signature and its `"ok"` branch (lines 285-324):

```ts
export async function pollForDeviceToken(
  authUrl: string,
  code: { device_code: string; interval: number; expires_in: number },
  io: DeviceLoginIo,
): Promise<DeviceSession> {
```

and inside the switch:

```ts
      case "ok":
        return { accessToken: result.accessToken, scope: result.scope };
```

Every other branch is unchanged.

- [ ] **Step 6: Use the echoed choice in `runDeviceLogin`**

In `packages/uploads/src/commands/login.ts`, replace the body of `runDeviceLogin` from the `io.write("signing in…")` call through the `mintWorkspaceToken` call (lines 258-273):

```ts
// Make the target explicit: a bare `uploads login` on a self-hosted install
// would otherwise silently sign in to the cloud service.
io.write(`signing in to ${opts.authUrl} (self-hosted? pass --api-url or set UPLOADS_API_URL)\n\n`);
const create = flagBool(parsed.flags, "--create");
const session = await obtainDeviceSession(
  opts.authUrl,
  { noOpen: opts.noOpen, scope: formatDeviceScope(requestedWorkspace, create) },
  io,
);

// The approval page is authoritative: it validated the workspace against the
// signed-in account's memberships (and may have created a new one) before
// approving. A scope that still carries `create` means the page deferred to
// the CLI, and an empty one means an older server that doesn't echo a
// choice — both fall back to the local resolution below.
const chosen = parseDeviceScope(session.scope);
const workspace =
  chosen.workspace && !chosen.create
    ? chosen.workspace
    : await resolveMintWorkspace(opts.apiUrl, session.accessToken, requestedWorkspace, io, create);
const minted = await mintWorkspaceToken(opts.apiUrl, session.accessToken, {
  workspace,
  scopes,
  label,
});
return { workspace: minted.workspace, token: minted.token, apiUrl: opts.apiUrl };
```

Delete the now-duplicated `const requestedWorkspace = …` only if you moved it; it stays where it is at line 256. Remove the old `flagBool(parsed.flags, "--create")` argument expression that was inlined into the `resolveMintWorkspace` call.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm test:cli -- commands-login`
Expected: PASS. The pre-existing `"errors when the account has multiple workspaces and none is chosen"` test must still pass — its mocked token response has `scope: ""`, so it takes the fallback path.

- [ ] **Step 8: Run the full CLI suite**

Run: `pnpm test:cli`
Expected: PASS — `commands/invite.ts` still compiles against `obtainDeviceAccessToken`.

- [ ] **Step 9: Commit**

```bash
git add packages/uploads/src/client.ts packages/uploads/src/commands/login.ts packages/uploads/test/commands-login.test.ts
git commit -m "feat(cli): carry the login workspace in the device-code scope (#362)"
```

---

### Task 3: CLI — actionable mint failure and reframed `--workspace` help

**Files:**

- Modify: `packages/uploads/src/commands/login.ts` (`HELP` constant lines 25-57, `runDeviceLogin` mint call)
- Test: `packages/uploads/test/commands-login.test.ts`

**Interfaces:**

- Consumes: Task 2's `runDeviceLogin` structure; `listMintWorkspaces` and `UploadsError` from `../client.js` / `../errors.js`.
- Produces: no new exports — behavior and copy only.

- [ ] **Step 1: Write the failing test**

Append to `packages/uploads/test/commands-login.test.ts`:

```ts
describe("runLogin device flow — mint failure backstop", () => {
  const silentIo: DeviceLoginIo = {
    sleep: async () => {},
    now: () => Date.now(),
    openUrl: () => {},
    write: () => {},
    isTTY: false,
    promptWorkspaceName: async () => "",
  };

  it("names the accessible workspaces when the mint is forbidden", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response({
          device_code: "dev-123",
          user_code: "ABCD-EFGH",
          verification_uri: "https://uploads.sh/device",
          expires_in: 900,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(
        response({ access_token: "sess-tok", token_type: "Bearer", expires_in: 3600, scope: "" }),
      )
      .mockResolvedValueOnce(
        response({ error: "no access to this workspace", code: "workspace_forbidden" }, 403),
      ) // POST /v1/tokens
      .mockResolvedValueOnce(
        response({
          workspaces: [
            { workspace: "acme", role: "member" },
            { workspace: "beta", role: "owner" },
          ],
        }),
      ); // GET /v1/tokens, fetched only to build the error
    captureOutput();

    await expect(
      runLogin(
        ["--path", path, "--workspace", "default", "--no-check"],
        { json: true },
        false,
        silentIo,
      ),
    ).rejects.toThrow(/no access to workspace "default".*acme, beta/s);
  });

  it("still fails clearly when the account has no workspaces at all", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response({
          device_code: "dev-123",
          user_code: "ABCD-EFGH",
          verification_uri: "https://uploads.sh/device",
          expires_in: 900,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(
        response({ access_token: "sess-tok", token_type: "Bearer", expires_in: 3600, scope: "" }),
      )
      .mockResolvedValueOnce(
        response({ error: "no access to this workspace", code: "workspace_forbidden" }, 403),
      )
      .mockResolvedValueOnce(response({ workspaces: [] }));
    captureOutput();

    await expect(
      runLogin(
        ["--path", path, "--workspace", "default", "--no-check"],
        { json: true },
        false,
        silentIo,
      ),
    ).rejects.toThrow(/no access to workspace "default".*--create/s);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:cli -- commands-login`
Expected: FAIL — the thrown message is the bare `no access to this workspace`.

- [ ] **Step 3: Wrap the mint call**

In `packages/uploads/src/commands/login.ts`, add this helper immediately above `runDeviceLogin`:

```ts
/**
 * Turn the API's deliberately opaque 403 (`no access to this workspace` — it
 * refuses to distinguish "doesn't exist" from "you're not a member", see
 * apps/api/src/routes/tokens.ts) into something the user can act on, by
 * listing the workspaces their own account CAN reach. Backstop only: since
 * #362 the approval page catches this before approving.
 */
async function describeMintFailure(
  apiUrl: string,
  accessToken: string,
  workspace: string,
  err: unknown,
): Promise<never> {
  if (!(err instanceof UploadsError) || err.status !== 403) throw err;
  let names: string[] = [];
  try {
    names = (await listMintWorkspaces(apiUrl, accessToken)).workspaces.map((w) => w.workspace);
  } catch {
    // Listing is best-effort — fall through to the generic hint below.
  }
  throw new UsageError(
    names.length
      ? `no access to workspace "${workspace}" — this account can use: ${names.join(", ")}`
      : `no access to workspace "${workspace}" — this account has no workspaces yet; pass --workspace <name> --create to provision one`,
  );
}
```

Add `UploadsError` to the existing import from `../client.js`'s sibling module — it lives in `../errors.js`:

```ts
import { UploadsError } from "../errors.js";
```

Then wrap the mint in `runDeviceLogin`:

```ts
const minted = await mintWorkspaceToken(opts.apiUrl, session.accessToken, {
  workspace,
  scopes,
  label,
}).catch((err) => describeMintFailure(opts.apiUrl, session.accessToken, workspace, err));
```

- [ ] **Step 4: Reframe the `--workspace` help text**

In the `HELP` constant, replace the description block and the `--workspace` / `--create` entries:

```
const HELP = `uploads login [options]

Sign in and save workspace credentials. With no flags, opens a browser to
authorize this device — the recommended way to sign in. The browser asks which
workspace to sign in to, so --workspace is optional. Pass an enrollment code
only if you were given one from before device login (fallback path).

Options:
  --workspace <name>  Preselect the workspace in the browser and skip its
                      picker (device flow)
  --create            With --workspace: create the workspace first if your
                      account doesn't have it yet (device flow only) — lets
                      scripted/agent logins provision without a prompt
```

Everything else in `HELP` is unchanged.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:cli -- commands-login`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/uploads/src/commands/login.ts packages/uploads/test/commands-login.test.ts
git commit -m "fix(cli): name accessible workspaces when a login mint is refused (#362)"
```

---

### Task 4: Web — approval panel state

**Files:**

- Create: `apps/web/src/lib/device-workspace.ts`
- Create: `apps/web/src/lib/device-workspace.test.ts`

**Interfaces:**

- Consumes: nothing — a pure function.
- Produces:
  - `interface DeviceWorkspaceOption { slug: string; name: string }`
  - `type DeviceWorkspaceState` — a discriminated union on `kind`: `"denied" | "provision" | "choose" | "first_run"`
  - `resolveDeviceWorkspaceState(input: { requested: string | null; create: boolean; workspaces: DeviceWorkspaceOption[] }): DeviceWorkspaceState`

  Task 6 renders each `kind`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/device-workspace.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveDeviceWorkspaceState } from "./device-workspace";

const acme = { slug: "acme", name: "Acme" };
const beta = { slug: "beta", name: "Beta" };

describe("resolveDeviceWorkspaceState", () => {
  it("blocks approval when the requested workspace isn't one of the caller's", () => {
    expect(
      resolveDeviceWorkspaceState({
        requested: "default",
        create: false,
        workspaces: [acme, beta],
      }),
    ).toEqual({ kind: "denied", requested: "default", options: [acme, beta] });
  });

  it("blocks with an empty option list when the caller has no workspaces at all", () => {
    expect(
      resolveDeviceWorkspaceState({ requested: "default", create: false, workspaces: [] }),
    ).toEqual({ kind: "denied", requested: "default", options: [] });
  });

  it("never blocks a --create request: the workspace legitimately may not exist yet", () => {
    expect(
      resolveDeviceWorkspaceState({ requested: "fresh", create: true, workspaces: [] }),
    ).toEqual({ kind: "provision", requested: "fresh" });
    expect(
      resolveDeviceWorkspaceState({ requested: "fresh", create: true, workspaces: [acme] }),
    ).toEqual({ kind: "provision", requested: "fresh" });
  });

  it("preselects the requested workspace when the caller is a member", () => {
    expect(
      resolveDeviceWorkspaceState({ requested: "beta", create: false, workspaces: [acme, beta] }),
    ).toEqual({ kind: "choose", options: [acme, beta], selected: "beta" });
  });

  it("defaults to the oldest membership when nothing was requested", () => {
    expect(
      resolveDeviceWorkspaceState({ requested: null, create: false, workspaces: [acme, beta] }),
    ).toEqual({ kind: "choose", options: [acme, beta], selected: "acme" });
  });

  it("still offers a choice for a single-workspace account", () => {
    expect(
      resolveDeviceWorkspaceState({ requested: null, create: false, workspaces: [acme] }),
    ).toEqual({ kind: "choose", options: [acme], selected: "acme" });
  });

  it("routes a first-run account into creation", () => {
    expect(resolveDeviceWorkspaceState({ requested: null, create: false, workspaces: [] })).toEqual(
      {
        kind: "first_run",
      },
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:web -- device-workspace`
Expected: FAIL — `Failed to resolve import "./device-workspace"`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/device-workspace.ts`:

```ts
/**
 * Which panel the /device approval page shows (issue #362). Kept out of
 * device.astro so the decision is unit-testable on its own — the pattern
 * session-device.ts already sets.
 *
 * `requested`/`create` come from GET /api/auth/device/workspace, which reads
 * them off the device-code row's scope: what the terminal asked for, not
 * anything the browser's URL claims.
 */

export interface DeviceWorkspaceOption {
  slug: string;
  name: string;
}

export type DeviceWorkspaceState =
  /** The terminal named a workspace this account can't reach — approval must not proceed as-is. */
  | { kind: "denied"; requested: string; options: DeviceWorkspaceOption[] }
  /** `uploads login --workspace X --create`: the CLI provisions after approval, so never block. */
  | { kind: "provision"; requested: string }
  /** Pick from the account's workspaces (or create a new one). */
  | { kind: "choose"; options: DeviceWorkspaceOption[]; selected: string }
  /** No workspaces and nothing requested — first run. */
  | { kind: "first_run" };

export function resolveDeviceWorkspaceState(input: {
  requested: string | null;
  create: boolean;
  workspaces: DeviceWorkspaceOption[];
}): DeviceWorkspaceState {
  const { requested, create, workspaces } = input;
  if (requested && create) return { kind: "provision", requested };
  const member = requested ? workspaces.find((w) => w.slug === requested) : undefined;
  if (requested && !member) return { kind: "denied", requested, options: workspaces };
  if (workspaces.length === 0) return { kind: "first_run" };
  // `workspaces` arrives oldest-membership-first from the auth worker, so
  // [0] is the same default the AS itself would resolve.
  return { kind: "choose", options: workspaces, selected: member?.slug ?? workspaces[0]!.slug };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:web -- device-workspace`
Expected: PASS, 7 cases.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/device-workspace.ts apps/web/src/lib/device-workspace.test.ts
git commit -m "feat(web): device approval workspace panel state (#362)"
```

---

### Task 5: Web — `devicePageCsp`

**Files:**

- Modify: `apps/web/src/lib/signed-in-page.ts` (add after `authPageCsp`, ~line 77)
- Test: `apps/web/src/lib/signed-in-page.test.ts`

**Interfaces:**

- Consumes: the file's existing `CF_RUM_CONNECT_SRC`, `CF_RUM_SCRIPT_SRC`, `STYLE_SRC_SELF_AND_INLINE` constants.
- Produces: `devicePageCsp(authOrigin: string, apiOrigin: string): string`. Task 6 applies it in `device.astro`.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/lib/signed-in-page.test.ts`, extending the existing import and the `"signed-in / auth CSP builders"` describe block:

```ts
it("devicePageCsp adds the API origin for inline workspace creation, nothing else", () => {
  const csp = devicePageCsp(AUTH, API);
  expect(csp).toContain(`connect-src ${AUTH} ${API}`);
  // Still an auth page: data: images only, unlike signedInCsp.
  expect(csp).toContain("img-src data:");
  expect(csp).not.toContain("img-src data: https:");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("form-action 'none'");
});
```

The file already defines `const AUTH = "https://auth.uploads.sh"` and `const API = "https://api.uploads.sh"` at the top — reuse them. Add `devicePageCsp` to the existing import on line 5.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:web -- signed-in-page`
Expected: FAIL — `devicePageCsp is not exported`.

- [ ] **Step 3: Write the implementation**

Add to `apps/web/src/lib/signed-in-page.ts`, directly after `authPageCsp`:

```ts
/**
 * CSP for `/device`. `authPageCsp` plus the API origin in `connect-src`: since
 * issue #362 the approval page can create a workspace inline (POST
 * /v1/workspaces on the API worker) for an account that has none. Deliberately
 * NOT `signedInCsp` — that one also relaxes `img-src` to `https:`, which this
 * page has no need for.
 */
export function devicePageCsp(authOrigin: string, apiOrigin: string): string {
  return [
    "default-src 'none'",
    `connect-src ${authOrigin} ${apiOrigin} ${CF_RUM_CONNECT_SRC}`,
    `script-src 'self' 'unsafe-inline' ${CF_RUM_SCRIPT_SRC}`,
    `style-src ${STYLE_SRC_SELF_AND_INLINE}`,
    "font-src 'self'",
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:web -- signed-in-page`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/signed-in-page.ts apps/web/src/lib/signed-in-page.test.ts
git commit -m "feat(web): device page CSP allowing API-origin workspace creation (#362)"
```

---

### Task 6: Web — `/device` picker, denied panel, and inline creation

**Files:**

- Modify: `apps/web/src/lib/auth-client.ts` (two new fetch helpers, near `approveDevice` at line ~311)
- Modify: `apps/web/src/pages/device.astro` (frontmatter, markup, script)

**Interfaces:**

- Consumes:
  - Task 1's `GET`/`POST /api/auth/device/workspace`
  - Task 4's `resolveDeviceWorkspaceState`, `DeviceWorkspaceOption`, `DeviceWorkspaceState`
  - Task 5's `devicePageCsp`
  - existing `createWorkspace(apiOrigin, name)` and `CreateWorkspaceResult` from `../lib/api-client`
  - existing `createErrorCopy(code)` from `../lib/workspace-ui`, `linkGitHub(authOrigin, returnTo)` from `../lib/auth-client`, `clearCachedWorkspaces()` from `../lib/workspaces-nav`
  - existing `resolveSignedInOrigins(env)` from `../lib/signed-in-page`
- Produces:
  - `interface DeviceWorkspaceLookup { requested: string | null; create: boolean; workspaces: { slug: string; name: string }[] }`
  - `getDeviceWorkspace(origin, userCode): Promise<{ ok: true; value: DeviceWorkspaceLookup } | { ok: false }>`
  - `setDeviceWorkspace(origin, userCode, workspace): Promise<boolean>`

- [ ] **Step 1: Add the auth-client helpers**

In `apps/web/src/lib/auth-client.ts`, insert directly after `denyDevice` (ends line ~338):

```ts
export interface DeviceWorkspaceLookup {
  requested: string | null;
  create: boolean;
  workspaces: { slug: string; name: string }[];
}

/**
 * GET /api/auth/device/workspace — what the terminal asked for plus the
 * workspaces this account can pick (issue #362). Returns `{ ok: false }` for
 * an unusable code or an outage so the caller can fall back to approving
 * without a workspace decision.
 */
export async function getDeviceWorkspace(
  origin: string,
  userCode: string,
): Promise<{ ok: true; value: DeviceWorkspaceLookup } | { ok: false }> {
  try {
    const res = await fetch(
      `${authOrigin(origin)}/api/auth/device/workspace?user_code=${encodeURIComponent(userCode)}`,
      { credentials: "include", cache: "no-store" },
    );
    if (!res.ok) return { ok: false };
    const body = (await res.json().catch(() => null)) as Partial<DeviceWorkspaceLookup> | null;
    if (!body || !Array.isArray(body.workspaces)) return { ok: false };
    return {
      ok: true,
      value: {
        requested: typeof body.requested === "string" ? body.requested : null,
        create: body.create === true,
        workspaces: body.workspaces.filter(
          (w): w is { slug: string; name: string } =>
            Boolean(w) && typeof w.slug === "string" && typeof w.name === "string",
        ),
      },
    };
  } catch {
    return { ok: false };
  }
}

/** POST /api/auth/device/workspace — record which workspace this login mints for. */
export async function setDeviceWorkspace(
  origin: string,
  userCode: string,
  workspace: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${authOrigin(origin)}/api/auth/device/workspace`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userCode, workspace }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Switch the page to `devicePageCsp`**

Replace the frontmatter of `apps/web/src/pages/device.astro` (lines 1-18):

```astro
---
import { env } from "cloudflare:workers";
import { applyAuthSecurityHeaders, devicePageCsp, resolveSignedInOrigins } from "../lib/signed-in-page";
import BaseHead from "../components/BaseHead.astro";
import Brand from "../components/Brand.astro";
import Footer from "../components/Footer.astro";
import GitHubMark from "../components/GitHubMark.astro";

export const prerender = false;

// The API origin is needed because a first-run account can create its
// workspace inline here (issue #362).
const { authOrigin, apiOrigin } = resolveSignedInOrigins(env);

// Header (not meta): frame-ancestors is ignored on meta CSP.
applyAuthSecurityHeaders(Astro.response.headers, devicePageCsp(authOrigin, apiOrigin));
---
```

- [ ] **Step 3: Add the workspace markup**

In `apps/web/src/pages/device.astro`, add these styles inside the existing `<style>` block (after the `.actions` rule):

```css
.ws {
  margin: 0 0 18px;
}
.ws label {
  display: block;
  color: var(--muted);
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-bottom: 6px;
}
.ws select {
  width: 100%;
  font: 14px var(--mono);
  color: var(--fg);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 9px 11px;
  appearance: none;
}
.ws select:focus-visible {
  border-color: var(--accent);
  outline: none;
}
.ws .fixed {
  font: 14px var(--mono);
  color: var(--fg);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 9px 11px;
}
.ws .note {
  color: var(--muted);
  font-size: 12px;
  margin: 6px 0 0;
}
.ws-new {
  margin-top: 10px;
}
.text-btn {
  background: none;
  border: 0;
  color: var(--accent);
  font: inherit;
  padding: 0;
  cursor: pointer;
  text-decoration: underline;
}
```

Replace the `#confirm` block (lines 100-108) with:

```astro
  <div id="confirm" hidden>
    <p>Signed in as <span id="who"></span>. A device is requesting access to your account:</p>
    <div class="code" id="code-display" aria-label="device code"></div>

    <div class="ws" id="ws-block" hidden>
      <label for="ws-select">Workspace</label>
      <select id="ws-select"></select>
      <div class="fixed" id="ws-fixed" hidden></div>
      <p class="note" id="ws-note" hidden></p>
      <div class="ws-new" id="ws-new" hidden>
        <label for="ws-name">New workspace name</label>
        <input id="ws-name" type="text" pattern="[a-z0-9][a-z0-9-]{1,62}" autocomplete="off" spellcheck="false" placeholder="workspace-name" />
        <p class="note">2–63 chars · lowercase letters, digits, hyphens</p>
      </div>
      <p class="note" id="ws-github" hidden>
        Creating a workspace requires a linked GitHub account.
        <button type="button" class="text-btn" id="ws-github-btn">Connect GitHub</button>
      </p>
    </div>

    <div class="actions">
      <button type="button" class="primary" id="approve-btn">Approve</button>
      <button type="button" class="secondary" id="deny-btn">Deny</button>
    </div>
    <div class="ul-callout status" id="confirm-error" data-state="error" role="alert" hidden></div>
  </div>

  <div id="no-access" hidden>
    <div class="ul-callout status" data-state="error" role="alert">
      Your account doesn't have access to a workspace named <strong id="na-name"></strong>.
    </div>
    <p id="na-have" hidden>This account can use: <span id="na-list"></span>.</p>
    <div class="actions">
      <button type="button" class="primary" id="na-choose">Choose a different workspace</button>
      <button type="button" class="secondary" id="na-deny">Deny</button>
    </div>
  </div>
```

In the same pass, replace the `#approved` block (lines 110-112) so the success
copy names the workspace — the whole point of the change is that the page and
the terminal now agree:

```astro
  <div id="approved" hidden>
    <div class="ul-callout status" data-state="ready" role="status">
      Device approved<span id="approved-ws-wrap" hidden> — signed in to <strong id="approved-ws"></strong></span>.
      Return to your terminal. You can close this page.
    </div>
  </div>
```

- [ ] **Step 4: Wire the script**

In `apps/web/src/pages/device.astro`, replace the `<script define:vars=…>` block (lines 120-122) so the API origin reaches the client too:

```astro
<script define:vars={{ authOrigin, apiOrigin }}>
  window.__UPLOADS_AUTH_ORIGIN__ = authOrigin;
  window.__UPLOADS_API_ORIGIN__ = apiOrigin;
</script>
```

Extend the module script's imports:

```ts
import {
  approveDevice,
  denyDevice,
  getDeviceStatus,
  getDeviceWorkspace,
  getSession,
  linkGitHub,
  sendMagicLink,
  setDeviceWorkspace,
  signInWithGitHub,
} from "../lib/auth-client";
import { createWorkspace } from "../lib/api-client";
import { resolveDeviceWorkspaceState, type DeviceWorkspaceState } from "../lib/device-workspace";
import { createErrorCopy } from "../lib/workspace-ui";
import { clearCachedWorkspaces } from "../lib/workspaces-nav";

const authOrigin = (window as unknown as { __UPLOADS_AUTH_ORIGIN__: string })
  .__UPLOADS_AUTH_ORIGIN__;
const apiOrigin = (window as unknown as { __UPLOADS_API_ORIGIN__: string }).__UPLOADS_API_ORIGIN__;
```

Add the new element handles next to the existing ones (after `confirmError`):

```ts
const wsBlock = requireElement<HTMLElement>("#ws-block");
const wsSelect = requireElement<HTMLElement>("#ws-select") as unknown as HTMLSelectElement;
const wsFixed = requireElement<HTMLElement>("#ws-fixed");
const wsNote = requireElement<HTMLElement>("#ws-note");
const wsNew = requireElement<HTMLElement>("#ws-new");
const wsName = requireElement<HTMLInputElement>("#ws-name");
const wsGithub = requireElement<HTMLElement>("#ws-github");
const wsGithubBtn = requireElement<HTMLButtonElement>("#ws-github-btn");
const noAccess = requireElement<HTMLElement>("#no-access");
const naName = requireElement<HTMLElement>("#na-name");
const naHave = requireElement<HTMLElement>("#na-have");
const naList = requireElement<HTMLElement>("#na-list");
const approvedWorkspace = requireElement<HTMLElement>("#approved-ws");
const approvedWorkspaceWrap = requireElement<HTMLElement>("#approved-ws-wrap");

/** Sentinel option value meaning "create a new workspace instead of picking one". */
const NEW_WORKSPACE = " new";

/** Null until the lookup runs — approval then skips the choice write entirely. */
let wsState: DeviceWorkspaceState | null = null;
```

Add `noAccess` to the `hideAll()` element list.

Replace `proceed()`'s tail (from `codeDisplay.textContent = …` onward) with:

```ts
    codeDisplay.textContent = formatUserCode(userCode);
    const lookup = await getDeviceWorkspace(authOrigin, userCode);
    wsState = lookup.ok ? resolveDeviceWorkspaceState(lookup.value) : null;
    renderWorkspace(wsState);
    confirmBox.hidden = false;
  }

  /** Paint the workspace block for a state, or route to the blocking no-access panel. */
  function renderWorkspace(state: DeviceWorkspaceState | null) {
    wsBlock.hidden = true;
    wsSelect.hidden = true;
    wsFixed.hidden = true;
    wsNote.hidden = true;
    wsNew.hidden = true;
    wsGithub.hidden = true;
    // An older auth worker (or a transient failure) leaves state null: approve
    // exactly as before and let the CLI resolve the workspace.
    if (!state) return;

    if (state.kind === "denied") {
      hideAll();
      naName.textContent = state.requested;
      naList.textContent = state.options.map((w) => w.slug).join(", ");
      naHave.hidden = state.options.length === 0;
      noAccess.hidden = false;
      return;
    }

    wsBlock.hidden = false;
    if (state.kind === "provision") {
      wsFixed.textContent = state.requested;
      wsFixed.hidden = false;
      wsNote.textContent = "Will be created in your terminal if it doesn't exist yet.";
      wsNote.hidden = false;
      return;
    }
    if (state.kind === "first_run") {
      wsNew.hidden = false;
      wsNote.textContent = "Your account doesn't have a workspace yet — name one to create it.";
      wsNote.hidden = false;
      return;
    }
    wsSelect.replaceChildren();
    for (const option of state.options) {
      const el = document.createElement("option");
      el.value = option.slug;
      el.textContent = option.name === option.slug ? option.slug : `${option.name} (${option.slug})`;
      wsSelect.appendChild(el);
    }
    const newOption = document.createElement("option");
    newOption.value = NEW_WORKSPACE;
    newOption.textContent = "New workspace…";
    wsSelect.appendChild(newOption);
    wsSelect.value = state.selected;
    wsSelect.hidden = false;
    wsNew.hidden = wsSelect.value !== NEW_WORKSPACE;
  }
```

Add the select's change handler and the GitHub link button, next to the other listeners:

```ts
wsSelect.addEventListener("change", () => {
  wsNew.hidden = wsSelect.value !== NEW_WORKSPACE;
  wsGithub.hidden = true;
});

wsGithubBtn.addEventListener("click", () => {
  wsGithubBtn.disabled = true;
  void linkGitHub(authOrigin, location.href).then((ok) => {
    if (!ok) wsGithubBtn.disabled = false;
  });
});

// The blocking panel's escape hatch: fall back to picking from what this
// account actually has (or creating one), rather than approving a login the
// terminal asked to point somewhere unreachable.
requireElement<HTMLButtonElement>("#na-choose").addEventListener("click", () => {
  const options = wsState?.kind === "denied" ? wsState.options : [];
  wsState = options.length
    ? { kind: "choose", options, selected: options[0]!.slug }
    : { kind: "first_run" };
  hideAll();
  renderWorkspace(wsState);
  confirmBox.hidden = false;
});

requireElement<HTMLButtonElement>("#na-deny").addEventListener("click", () => {
  void denyDevice(authOrigin, userCode).then(() => {
    hideAll();
    denied.hidden = false;
  });
});
```

Replace the `decide(...)` factory and the approve binding (lines 277-301) with:

```ts
/**
 * Resolve the workspace this approval should mint for, creating one first
 * when the user asked for that. Returns the slug, `null` when there's
 * nothing to record (provision / unknown state), or `false` when the step
 * failed and approval must NOT proceed.
 */
async function settleWorkspace(): Promise<string | null | false> {
  if (!wsState || wsState.kind === "provision" || wsState.kind === "denied") return null;
  const creating = wsState.kind === "first_run" || wsSelect.value === NEW_WORKSPACE;
  if (!creating) return wsSelect.value;

  const name = wsName.value.trim();
  if (!name) {
    confirmError.textContent = "Enter a name for the new workspace.";
    confirmError.hidden = false;
    return false;
  }
  const created = await createWorkspace(apiOrigin, name);
  if (created.kind === "created") {
    // Drop the sidebar membership cache so /account reflects the new
    // workspace on its next paint.
    clearCachedWorkspaces();
    return created.workspace.name;
  }
  if (created.kind === "error" && created.code === "github_required") {
    wsGithub.hidden = false;
    return false;
  }
  confirmError.textContent =
    created.kind === "unavailable"
      ? "The API is unreachable right now — try again shortly."
      : createErrorCopy(created.code);
  confirmError.hidden = false;
  return false;
}

approveBtn.addEventListener("click", () => {
  void (async () => {
    confirmError.hidden = true;
    wsGithub.hidden = true;
    approveBtn.disabled = true;
    denyBtn.disabled = true;
    const release = () => {
      approveBtn.disabled = false;
      denyBtn.disabled = false;
    };

    const workspace = await settleWorkspace();
    if (workspace === false) return release();

    // Record the choice BEFORE approving: once the row flips to approved the
    // CLI can claim its token, and it must never read a stale workspace.
    if (workspace && !(await setDeviceWorkspace(authOrigin, userCode, workspace))) {
      release();
      confirmError.textContent = "Couldn't save your workspace choice — try again.";
      confirmError.hidden = false;
      return;
    }

    if (!(await approveDevice(authOrigin, userCode))) {
      release();
      confirmError.textContent = "Couldn't approve the device. The code may have expired.";
      confirmError.hidden = false;
      return;
    }
    hideAll();
    approvedWorkspace.textContent = workspace ?? "";
    approvedWorkspaceWrap.hidden = !workspace;
    approved.hidden = false;
  })();
});

denyBtn.addEventListener("click", () => {
  void (async () => {
    confirmError.hidden = true;
    approveBtn.disabled = true;
    denyBtn.disabled = true;
    if (await denyDevice(authOrigin, userCode)) {
      hideAll();
      denied.hidden = false;
      return;
    }
    approveBtn.disabled = false;
    denyBtn.disabled = false;
    confirmError.textContent = "Couldn't deny the device. The code may have expired.";
    confirmError.hidden = false;
  })();
});
```

- [ ] **Step 5: Typecheck and run the web suite**

Run: `pnpm typecheck && pnpm test:web`
Expected: PASS. Typecheck catches any element-handle or import mistakes in the `.astro` script.

- [ ] **Step 6: Verify the page in the browser**

Start the dev stack and open `/device` with a seeded pending code (see `docs/superpowers/specs/2026-07-21-device-login-workspace-selection-design.md` and the device-flow notes in `AGENTS.md`). Use `preview_start` with the project's `.claude/launch.json` entry, then `read_page` to confirm: the picker renders for a multi-workspace account, and a `workspace:default` scope on a non-member account renders the no-access panel instead of Approve. Check `read_console_messages` for CSP violations — a blocked `connect-src` to the API origin means Task 5 wasn't applied.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/auth-client.ts apps/web/src/pages/device.astro
git commit -m "feat(web): workspace picker and access check on the device approval page (#362)"
```

---

### Task 7: Docs and changeset

**Files:**

- Modify: `docs/cli.md` (login section)
- Create: `.changeset/device-login-workspace-selection.md`

**Interfaces:**

- Consumes: the shipped behavior from Tasks 1-6.
- Produces: no code.

- [ ] **Step 1: Update the CLI docs**

In `docs/cli.md`'s "Getting started" section, replace the paragraph that begins
"An uploads.sh administrator invites your email to a workspace first…" (lines
21-26) with:

```markdown
`login` opens a browser to authorize this device. The approval page asks which
workspace to sign in to — pick one, or name a new one if the account has none —
so `uploads login` needs no flags even when you belong to several workspaces.
The workspace is settled there, before approval: a workspace your account can't
reach is refused on the page rather than reported as a success that then fails
in your terminal.

Pass `--workspace <name>` to preselect a workspace and skip the picker, and
`--workspace <name> --create` to provision one by name (the one thing the picker
can't express). An invitation from a workspace admin also works — `login` trades
an enrollment code for a saved workspace token, and `logout` removes it.
`uploads doctor` checks health, auth, and workspace access when something's off.
Routine agents never receive or need `ADMIN_TOKEN`. See
[enrollment](enrollment.md).
```

Leave the surrounding code fence and the `pnpm workspace:add` paragraph as they are.

- [ ] **Step 2: Add the changeset**

Create `.changeset/device-login-workspace-selection.md`:

```markdown
---
"@buildinternet/uploads": minor
---

Device login now picks the workspace in the browser. `uploads login` works with
no flags for every account — the approval page lists the workspaces you can use,
creates one if you have none, and refuses to approve a workspace your account
can't reach instead of reporting success and failing in the terminal.
`--workspace` becomes an optional preselect; `--workspace <name> --create` still
provisions by name.
```

Only `@buildinternet/uploads` is named — a changeset naming an ignored package (web/api/mcp/auth) silently blocks every publish.

- [ ] **Step 3: Verify the whole suite and formatting**

Run: `pnpm test && pnpm typecheck && pnpm check`
Expected: PASS on all three.

- [ ] **Step 4: Commit**

```bash
git add docs/cli.md .changeset/device-login-workspace-selection.md
git commit -m "docs(cli): browser-side workspace selection for device login (#362)"
```

---

## Verification

Before opening the PR, confirm end-to-end against the local stack:

1. **The reported bug.** `uploads login --workspace default --force` as a user with no `default` membership → the `/device` page shows "Your account doesn't have access to a workspace named `default`" with no Approve button, and the terminal never reports a false success.
2. **Multi-workspace.** A bare `uploads login` on an account with two workspaces → picker on the page, and the terminal mints for whichever was chosen (check `UPLOADS_WORKSPACE` in the written config).
3. **First run.** A bare `uploads login` on an account with no workspaces → the page's create field provisions, and the CLI mints for the created workspace.
4. **Provisioning still works.** `uploads login --workspace brand-new --create` → the page shows the informational line, and the CLI creates and mints.

Open the PR with `gh pr create`, and attach a screenshot of the no-access panel and the picker using the `github-screenshots` skill — this is a visible UI change.
