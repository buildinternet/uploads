# Self-Serve Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a GitHub-signed-in user create shared-bucket workspaces themselves — `POST /v1/workspaces` provisions the Better Auth org (with the caller as owner) plus the KV `ws:<name>` record, surfaced in web `/account/workspaces` and `uploads login`.

**Architecture:** New session-authed route in `apps/api` (owner of REGISTRY KV) orchestrates: slug policy check → GitHub-linked gate → per-user cap → org provisioning via the `AUTH` service binding (new `/internal/orgs/provision` on `apps/auth`, which seeds an owner membership) → KV record write with self-serve limits, with a compensating org delete if the KV write fails. Web and CLI call the one endpoint.

**Tech Stack:** Cloudflare Workers, Hono, Better Auth + drizzle/D1 (apps/auth), KV (REGISTRY), Vitest (plain Node with hand-rolled fakes), Astro (apps/web), Node CLI (packages/uploads).

**Spec:** `docs/superpowers/specs/2026-07-14-self-serve-registration-design.md`

## Global Constraints

- Workspace name shape: `WS_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/` (`apps/api/src/workspace.ts:83`).
- Reserved names (min): `default`, `admin`, `api`, `www`, `storage`, `embed`, `auth`, `mcp`, `f`, `public`, `account`, `me`, `invite`.
- Blocklist rejections return the same `invalid_workspace_name` code as regex failures — never echo why.
- Self-serve limits: `maxStorageBytes: 1_000_000_000` (1 GB), `maxUploadsPerPeriod: 3000` (per UTC month — the record has no daily field; this is the spec's "daily budget" mapped to the existing monthly counter), `maxUploadBytes: 25_000_000`, `maxVideoUploadBytes: 8_000_000`, `allowedKeyPrefixes: ["f","screenshots","gh"]`, `maxKeyDepth: 8`.
- Per-user self-serve workspace cap: 3.
- GitHub sign-in required to create; magic-link users get `403 github_required`.
- Error-code contract for `POST /v1/workspaces` (clients key off these): `400 invalid_workspace_name`, `400 reserved_workspace_name`, `403 github_required`, `403 workspace_cap_reached`, `409 workspace_name_taken`, `429` rate-limited.
- Monorepo commands: run tests with `pnpm --filter @uploads/api test` / `@uploads/auth` / `@uploads/web`; `pnpm --filter uploads test` for the CLI package. Commit hooks run oxfmt + types — commit normally, don't bypass hooks.
- Never touch `.env` / `.dev.vars` files.

## Task lanes (for the coordinating session)

- **Lane 1 (apps/auth):** Task 1. Independent.
- **Lane 2 (apps/api):** Tasks 2 → 3 → 4 (sequential; Task 4 also consumes Task 1's routes but only via stubbed fetches in tests, so Lane 2 can run in parallel with Lane 1).
- **Lane 3 (apps/web):** Tasks 5 → 6. Consumes only the error-code contract above.
- **Lane 4 (packages/uploads):** Task 7. Consumes only the endpoint contract.
- **Task 8 (docs):** after all lanes merge.

---

### Task 1: Auth internal routes — org provisioning, deletion, GitHub-link check

**Files:**

- Modify: `apps/auth/src/internal-routes.ts` (append three routes to the `internal` Hono app)
- Test: `apps/auth/src/internal-routes.test.ts` (extend)

**Interfaces:**

- Consumes: existing drizzle `schema` (`organization`, `member`, `user`, `account` tables in `apps/auth/src/schema.ts`; `account` has `userId`, `providerId` columns).
- Produces (service-binding HTTP, all under the existing `isInternalRequest` guard):
  - `POST /internal/orgs/provision` body `{ slug: string, name?: string, ownerUserId: string }` → `201 { organization: { id, slug, name } }`; `400 invalid_request`; `404 user_not_found`; `409 slug_taken`.
  - `DELETE /internal/orgs/:slug` → `200 { ok: true }`; `404 organization_not_found`; `409 org_not_empty` when member count > 1.
  - `GET /internal/users/:id/github-linked` → `200 { githubLinked: boolean }`.

- [ ] **Step 1: Write the failing tests.** Open `apps/auth/src/internal-routes.test.ts` first and reuse its existing harness (fake D1/drizzle setup and `app.request` invocation style) exactly — do not invent a new one. Add a describe block with these cases (bodies below show the assertion shape; adapt seeding calls to the file's existing helpers):

```ts
describe("POST /internal/orgs/provision", () => {
  it("creates the org and seeds an owner member", async () => {
    // seed: user { id: "u1", email: "a@x.com" }
    const res = await request("/internal/orgs/provision", {
      method: "POST",
      body: JSON.stringify({ slug: "zachbot", ownerUserId: "u1" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.organization.slug).toBe("zachbot");
    // assert a member row exists: organizationId = body.organization.id, userId "u1", role "owner"
  });
  it("409s when the slug already exists", async () => {
    // seed: organization { slug: "zachbot" }, user "u1"
    // expect status 409, error.code "slug_taken"
  });
  it("404s for an unknown ownerUserId", async () => {
    // expect status 404, error.code "user_not_found"
  });
  it("400s when slug or ownerUserId is missing", async () => {
    // expect status 400, error.code "invalid_request"
  });
});

describe("DELETE /internal/orgs/:slug", () => {
  it("deletes an org with a single (owner) member and its member rows", async () => {
    // seed org + one member; expect 200 {ok:true}; org and member rows gone
  });
  it("409s when the org has more than one member", async () => {
    // seed org + two members; expect 409, error.code "org_not_empty"
  });
  it("404s for an unknown slug", async () => {});
});

describe("GET /internal/users/:id/github-linked", () => {
  it("true when an account row with providerId github exists", async () => {
    // seed account { userId: "u1", providerId: "github", accountId: "999" }
    // expect { githubLinked: true }
  });
  it("false otherwise (including unknown user)", async () => {
    // expect { githubLinked: false }
  });
});
```

- [ ] **Step 2: Run to verify failure.** `pnpm --filter @uploads/auth test -- internal-routes` — expect the new cases to FAIL (404s from unrouted paths).

- [ ] **Step 3: Implement.** Append to the `internal` Hono chain in `apps/auth/src/internal-routes.ts` (after the existing `.post("/orgs", …)` block, before `/orgs/:slug` so the static `provision` segment can't be captured — Hono matches static over param, but keep ordering explicit anyway):

```ts
  // Self-serve provisioning (spec 2026-07-14): create an org WITH the caller
  // as owner member, non-idempotent — a taken slug is a 409 the API surfaces
  // to the user, unlike POST /orgs (admin backfill, idempotent by design).
  .post("/orgs/provision", async (c) => {
    const body = await c.req
      .json<{ slug?: unknown; name?: unknown; ownerUserId?: unknown }>()
      .catch(() => ({}) as { slug?: unknown; name?: unknown; ownerUserId?: unknown });
    const slug = typeof body.slug === "string" ? body.slug.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const ownerUserId = typeof body.ownerUserId === "string" ? body.ownerUserId.trim() : "";
    if (!slug || !ownerUserId) {
      return c.json(errorJson("invalid_request", "slug and ownerUserId are required"), 400);
    }

    const db = drizzle(c.env.DB, { schema });
    const [owner] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, ownerUserId))
      .limit(1);
    if (!owner) {
      return c.json(errorJson("user_not_found", "no user with that id"), 404);
    }

    const [existing] = await db
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.slug, slug))
      .limit(1);
    if (existing) {
      return c.json(errorJson("slug_taken", "an organization with that slug already exists"), 409);
    }

    const id = crypto.randomUUID();
    try {
      await db.insert(schema.organization).values({
        id,
        slug,
        name: name || slug,
        createdAt: new Date(),
      });
    } catch {
      // UNIQUE-constraint race with a concurrent provision: the loser reports
      // the same 409 the pre-check would have.
      return c.json(errorJson("slug_taken", "an organization with that slug already exists"), 409);
    }
    await db.insert(schema.member).values({
      id: crypto.randomUUID(),
      organizationId: id,
      userId: owner.id,
      role: "owner",
      createdAt: new Date(),
    });
    return c.json({ organization: { id, slug, name: name || slug } }, 201);
  })
  // Compensating action for self-serve provisioning: roll back an org whose
  // KV workspace write failed. Refuses orgs that have grown past their sole
  // owner so it can never be used to destroy a real team.
  .delete("/orgs/:slug", async (c) => {
    const slug = c.req.param("slug");
    const db = drizzle(c.env.DB, { schema });
    const [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, slug))
      .limit(1);
    if (!org) {
      return c.json(errorJson("organization_not_found", "no organization with that slug"), 404);
    }
    const members = await db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(eq(schema.member.organizationId, org.id));
    if (members.length > 1) {
      return c.json(errorJson("org_not_empty", "organization has more than one member"), 409);
    }
    await db.delete(schema.member).where(eq(schema.member.organizationId, org.id));
    await db.delete(schema.organization).where(eq(schema.organization.id, org.id));
    return c.json({ ok: true });
  })
  // Self-serve gate: does this user have a linked GitHub account?
  .get("/users/:id/github-linked", async (c) => {
    const userId = c.req.param("id");
    const db = drizzle(c.env.DB, { schema });
    const [row] = await db
      .select({ id: schema.account.id })
      .from(schema.account)
      .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, "github")))
      .limit(1);
    return c.json({ githubLinked: Boolean(row) });
  })
```

(`and` is already imported at the top of the file.)

- [ ] **Step 4: Run to verify pass.** `pnpm --filter @uploads/auth test -- internal-routes` — expect PASS, including the pre-existing cases.

- [ ] **Step 5: Commit.**

```bash
git add apps/auth/src/internal-routes.ts apps/auth/src/internal-routes.test.ts
git commit -m "feat(auth): internal org provision/delete and github-linked routes"
```

---

### Task 2: Slug policy — reserved names + offensive-terms blocklist

**Files:**

- Create: `apps/api/src/slug-policy.ts`
- Create: `apps/api/src/slug-blocklist.ts`
- Test: `apps/api/src/slug-policy.test.ts`

**Interfaces:**

- Consumes: `WS_NAME_RE` from `apps/api/src/workspace.ts`.
- Produces: `validateSlug(name: string): { ok: true } | { ok: false; code: "invalid_workspace_name" | "reserved_workspace_name" }` and `RESERVED_WORKSPACE_NAMES: ReadonlySet<string>`.

- [ ] **Step 1: Vendor the blocklist.** Create `apps/api/src/slug-blocklist.ts` containing the English list from LDNOOBW ("List of Dirty, Naughty, Obscene, and Otherwise Bad Words", https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words, file `en`, pinned to the latest commit at implementation time — record the commit hash in the file header). Fetch it (e.g. `curl -s https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/en`), keep only single-token entries of 4+ letters (short entries like 3-letter terms cause rampant substring false positives), lowercase, strip non-`a-z` characters. File shape:

```ts
/**
 * Offensive-terms blocklist for workspace slugs (spec 2026-07-14, D-slug).
 * Source: LDNOOBW en list, commit <hash>. Filtered to single tokens of 4+
 * letters. Matched as substrings of the letters-only slug — see slug-policy.ts.
 */
export const SLUG_BLOCKLIST: readonly string[] = [
  // ...vendored entries, one per line, sorted...
];

/** Innocent words that contain a blocklisted substring (Scunthorpe problem). */
export const SLUG_BLOCKLIST_ALLOW: readonly string[] = [
  "scunthorpe",
  "assets",
  "assistant",
  "assignment",
  "class",
  "classic",
  "cassette",
  "shitake", // common misspelling of shiitake
  "sussex",
  "essex",
];
```

Extend `SLUG_BLOCKLIST_ALLOW` with any false positives the tests below surface.

- [ ] **Step 2: Write the failing tests** in `apps/api/src/slug-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateSlug } from "./slug-policy";

describe("validateSlug", () => {
  it("accepts ordinary slugs", () => {
    for (const s of ["zach", "my-project-2", "buildinternet"]) {
      expect(validateSlug(s)).toEqual({ ok: true });
    }
  });
  it("rejects malformed slugs as invalid_workspace_name", () => {
    for (const s of ["", "A", "-lead", "x", "café", "a".repeat(64)]) {
      expect(validateSlug(s)).toEqual({ ok: false, code: "invalid_workspace_name" });
    }
  });
  it("rejects reserved names with reserved_workspace_name", () => {
    for (const s of ["default", "admin", "api", "storage", "me"]) {
      expect(validateSlug(s)).toEqual({ ok: false, code: "reserved_workspace_name" });
    }
  });
  it("rejects blocklisted terms as plain invalid_workspace_name (no distinct code)", () => {
    // Pick two entries actually present in the vendored list at implementation
    // time; hyphens/digits must not defeat the match.
    expect(validateSlug("some-slur-here")).toEqual({ ok: false, code: "invalid_workspace_name" });
    expect(validateSlug("s0me-slur")).toMatchObject({ ok: false });
  });
  it("allows Scunthorpe-style false positives", () => {
    for (const s of ["scunthorpe", "assets-team", "classic-cars"]) {
      expect(validateSlug(s)).toEqual({ ok: true });
    }
  });
});
```

- [ ] **Step 3: Run to verify failure.** `pnpm --filter @uploads/api test -- slug-policy` — FAIL (module not found).

- [ ] **Step 4: Implement** `apps/api/src/slug-policy.ts`:

```ts
import { WS_NAME_RE } from "./workspace";
import { SLUG_BLOCKLIST, SLUG_BLOCKLIST_ALLOW } from "./slug-blocklist";

/** Names that collide with routes, subdomains, or communal tenants. */
export const RESERVED_WORKSPACE_NAMES: ReadonlySet<string> = new Set([
  "default",
  "admin",
  "api",
  "www",
  "storage",
  "embed",
  "auth",
  "mcp",
  "f",
  "public",
  "account",
  "me",
  "invite",
  "uploads",
  "internal",
  "v1",
]);

export type SlugVerdict =
  | { ok: true }
  | { ok: false; code: "invalid_workspace_name" | "reserved_workspace_name" };

/**
 * Reduce a slug to bare letters so `s0me-slur` and `some-slur` normalize to
 * the same string before the substring scan. Digit→letter lookalikes are
 * folded (0→o, 1→i, 3→e, 4→a, 5→s, 7→t).
 */
function lettersOnly(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/[^a-z]/g, "");
}

function blocked(slug: string): boolean {
  const flat = lettersOnly(slug);
  // Any allowlisted word neutralizes the exact span it covers; simplest sound
  // approximation: if the flat string equals or contains only allowlisted
  // words around the hit, skip. We keep it simple: a slug whose flat form
  // contains an allowlisted word that itself contains the blocklist hit is OK.
  for (const term of SLUG_BLOCKLIST) {
    const at = flat.indexOf(term);
    if (at === -1) continue;
    const excused = SLUG_BLOCKLIST_ALLOW.some(
      (allow) => allow.includes(term) && flat.includes(allow),
    );
    if (!excused) return true;
  }
  return false;
}

/** Blocklist verdicts intentionally reuse invalid_workspace_name — never echo why. */
export function validateSlug(name: string): SlugVerdict {
  if (!WS_NAME_RE.test(name)) return { ok: false, code: "invalid_workspace_name" };
  if (RESERVED_WORKSPACE_NAMES.has(name)) return { ok: false, code: "reserved_workspace_name" };
  if (blocked(name)) return { ok: false, code: "invalid_workspace_name" };
  return { ok: true };
}
```

- [ ] **Step 5: Run to verify pass.** `pnpm --filter @uploads/api test -- slug-policy` — PASS. Fix any allowlist gaps the tests reveal by adding entries to `SLUG_BLOCKLIST_ALLOW`.

- [ ] **Step 6: Commit.**

```bash
git add apps/api/src/slug-policy.ts apps/api/src/slug-blocklist.ts apps/api/src/slug-policy.test.ts
git commit -m "feat(api): workspace slug policy with reserved names and blocklist"
```

---

### Task 3: Self-serve workspace record defaults

**Files:**

- Modify: `apps/api/src/workspace.ts` (add three optional fields to `WorkspaceRecord`)
- Create: `apps/api/src/self-serve-defaults.ts`
- Test: `apps/api/src/self-serve-defaults.test.ts`

**Interfaces:**

- Consumes: `WorkspaceRecord` from `./workspace`.
- Produces: `SELF_SERVE_LIMITS` const; `selfServeWorkspaceRecord(args: { name: string; userId: string; now: Date }): WorkspaceRecord`; new `WorkspaceRecord` fields `selfServe?: boolean`, `createdByUserId?: string`, `createdAt?: string`.

- [ ] **Step 1: Write the failing test** `apps/api/src/self-serve-defaults.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { selfServeWorkspaceRecord, SELF_SERVE_LIMITS } from "./self-serve-defaults";

describe("selfServeWorkspaceRecord", () => {
  it("builds a shared-bucket prefixed record with self-serve limits", () => {
    const record = selfServeWorkspaceRecord({
      name: "zachbot",
      userId: "u1",
      now: new Date("2026-07-14T00:00:00Z"),
    });
    expect(record).toMatchObject({
      provider: "r2",
      bucket: "uploads-default",
      binding: "UPLOADS_DEFAULT",
      prefix: "zachbot/",
      publicBaseUrl: "https://storage.uploads.sh",
      selfServe: true,
      createdByUserId: "u1",
      createdAt: "2026-07-14T00:00:00.000Z",
      maxStorageBytes: 1_000_000_000,
      maxUploadsPerPeriod: 3000,
      maxUploadBytes: 25_000_000,
      maxVideoUploadBytes: 8_000_000,
      allowedKeyPrefixes: ["f", "screenshots", "gh"],
      maxKeyDepth: 8,
    });
    expect(record.tokens).toBeUndefined(); // tokens are minted via POST /v1/tokens, never seeded
  });
  it("returns a fresh allowedKeyPrefixes array per call", () => {
    const a = selfServeWorkspaceRecord({ name: "a", userId: "u", now: new Date(0) });
    const b = selfServeWorkspaceRecord({ name: "b", userId: "u", now: new Date(0) });
    expect(a.allowedKeyPrefixes).not.toBe(b.allowedKeyPrefixes);
  });
  it("limits are 1GB/3000-per-month", () => {
    expect(SELF_SERVE_LIMITS.maxStorageBytes).toBe(1_000_000_000);
    expect(SELF_SERVE_LIMITS.maxUploadsPerPeriod).toBe(3000);
  });
});
```

- [ ] **Step 2: Run to verify failure.** `pnpm --filter @uploads/api test -- self-serve-defaults` — FAIL.

- [ ] **Step 3: Implement.** Add to `WorkspaceRecord` in `apps/api/src/workspace.ts` (after `maxKeyDepth`, keeping the doc-comment style of the file):

```ts
  /** True for workspaces provisioned by the self-serve flow (POST /v1/workspaces). */
  selfServe?: boolean;
  /** Better Auth user id that created this workspace via self-serve. */
  createdByUserId?: string;
  /** ISO timestamp of self-serve creation. */
  createdAt?: string;
```

Create `apps/api/src/self-serve-defaults.ts`:

```ts
/**
 * Record template for self-serve workspaces (spec 2026-07-14, D3).
 * Deliberately tighter than the operator template in
 * scripts/workspace-limit-defaults.json (25 GB): self-serve tenants start at
 * 1 GB / 3000 uploads per UTC month; raises are admin-only.
 */
import type { WorkspaceRecord } from "./workspace";

export const SELF_SERVE_LIMITS = {
  maxStorageBytes: 1_000_000_000,
  maxUploadsPerPeriod: 3000,
  maxUploadBytes: 25_000_000,
  maxVideoUploadBytes: 8_000_000,
  allowedKeyPrefixes: ["f", "screenshots", "gh"] as const,
  maxKeyDepth: 8,
} as const;

export function selfServeWorkspaceRecord(args: {
  name: string;
  userId: string;
  now: Date;
}): WorkspaceRecord {
  return {
    provider: "r2",
    bucket: "uploads-default",
    binding: "UPLOADS_DEFAULT",
    prefix: `${args.name}/`,
    publicBaseUrl: "https://storage.uploads.sh",
    selfServe: true,
    createdByUserId: args.userId,
    createdAt: args.now.toISOString(),
    maxStorageBytes: SELF_SERVE_LIMITS.maxStorageBytes,
    maxUploadsPerPeriod: SELF_SERVE_LIMITS.maxUploadsPerPeriod,
    maxUploadBytes: SELF_SERVE_LIMITS.maxUploadBytes,
    maxVideoUploadBytes: SELF_SERVE_LIMITS.maxVideoUploadBytes,
    allowedKeyPrefixes: [...SELF_SERVE_LIMITS.allowedKeyPrefixes],
    maxKeyDepth: SELF_SERVE_LIMITS.maxKeyDepth,
  };
}
```

- [ ] **Step 4: Run to verify pass.** `pnpm --filter @uploads/api test -- self-serve-defaults` — PASS. Also run `pnpm --filter @uploads/api test` in full to confirm the `WorkspaceRecord` change breaks nothing.

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/workspace.ts apps/api/src/self-serve-defaults.ts apps/api/src/self-serve-defaults.test.ts
git commit -m "feat(api): self-serve workspace record template and limits"
```

---

### Task 4: `POST /v1/workspaces` provisioning route

**Files:**

- Modify: `apps/api/src/org-workspaces.ts` (add three AUTH-binding helpers)
- Create: `apps/api/src/routes/workspaces.ts`
- Modify: `apps/api/src/index.ts` (mount `.route("/v1/workspaces", workspaces)` immediately after the existing `.route("/v1/tokens", tokens)` at line 69, before the `/v1/:workspace/*` mounts)
- Test: `apps/api/src/routes/workspaces.test.ts`

**Interfaces:**

- Consumes: Task 1's internal routes (stubbed in tests); Task 2's `validateSlug`; Task 3's `selfServeWorkspaceRecord`; existing `sessionAuth`/`requireSessionUser` (`../session-auth`), `membershipsForUser` (`../org-workspaces`), `loadWorkspaceRecord` (`../workspace`), `allowWrite` (`../guards`).
- Produces: `POST /v1/workspaces` body `{ name: string }` → `201 { workspace: { name, publicBaseUrl, selfServe: true } }` plus the Global Constraints error-code contract. New exports on `org-workspaces.ts`: `provisionOrg(env, args: { slug: string; name?: string; ownerUserId: string }): Promise<OrgSummary>` (throws `ConflictError` code `workspace_name_taken` on 409, `ServiceUnavailableError` otherwise), `deleteOrg(env, slug): Promise<void>`, `isGithubLinked(env, userId): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests** in `apps/api/src/routes/workspaces.test.ts`, following the harness in `apps/api/src/routes/tokens.test.ts` (read it first; reuse its `stubEnv`-style construction — AUTH stub answering `get-session`, `/internal/*` paths; `fakeKv` with a captured `put`). Cases:

```ts
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { respondError } from "@uploads/errors"; // match tokens.test.ts's onError import
import { workspaces } from "./workspaces";

const USER = { id: "u1", email: "z@x.com", name: "Zach" };

// Build stubEnv({ session, githubLinked, memberships, kvRecords, provision, deleteOrg })
// mirroring tokens.test.ts: AUTH fetch stub switches on URL path:
//   /api/auth/get-session        -> { session: {}, user: USER } | null
//   /internal/users/u1/github-linked -> { githubLinked }
//   /internal/memberships        -> memberships array
//   /internal/orgs/provision     -> provision() result (201/409)
//   DELETE /internal/orgs/:slug  -> record the call, 200
// REGISTRY fake: get returns kvRecords["ws:<name>"]; put captures (key, value)
// and can be made to throw.

const app = () =>
  new Hono<{ Bindings: Env }>()
    .route("/v1/workspaces", workspaces)
    .onError((err, c) => respondError(c, err));

describe("POST /v1/workspaces", () => {
  it("401s with no session", async () => {
    /* session: null -> expect 401 */
  });
  it("400s on invalid and reserved names", async () => {
    // name "Bad_Name" -> 400 code invalid_workspace_name
    // name "admin"    -> 400 code reserved_workspace_name
  });
  it("403s code github_required when no GitHub account is linked", async () => {});
  it("403s code workspace_cap_reached at 3 owned self-serve workspaces", async () => {
    // memberships: 3 owner rows whose slugs map to kvRecords with selfServe: true
  });
  it("does not count non-self-serve (BYO) owned workspaces toward the cap", async () => {
    // 3 owner memberships but records lack selfServe -> creation succeeds
  });
  it("409s code workspace_name_taken when the KV record exists", async () => {});
  it("409s code workspace_name_taken when org provisioning returns 409", async () => {});
  it("creates org then KV record and returns 201", async () => {
    // assert provision called with { slug, ownerUserId: "u1" }
    // assert KV put key "ws:zachbot" and parsed value matches
    //   selfServeWorkspaceRecord shape (selfServe true, prefix "zachbot/")
    // assert response 201 { workspace: { name: "zachbot", publicBaseUrl, selfServe: true } }
  });
  it("rolls back the org when the KV write throws", async () => {
    // put throws -> expect 5xx AND DELETE /internal/orgs/zachbot was called
  });
});
```

- [ ] **Step 2: Run to verify failure.** `pnpm --filter @uploads/api test -- routes/workspaces` — FAIL (module not found).

- [ ] **Step 3: Add the AUTH-binding helpers** to `apps/api/src/org-workspaces.ts` (below `workspacesForOrg`, reusing the file's `INTERNAL_ORIGIN` / `internalHeaders`):

```ts
/** Self-serve org provisioning (spec 2026-07-14): org + owner member in one call. */
export async function provisionOrg(
  env: Env,
  args: { slug: string; name?: string; ownerUserId: string },
): Promise<OrgSummary> {
  const headers = internalHeaders();
  headers.set("content-type", "application/json");
  const response = await env.AUTH.fetch(`${INTERNAL_ORIGIN}/internal/orgs/provision`, {
    method: "POST",
    headers,
    body: JSON.stringify(args),
  });
  if (response.status === 409) {
    throw new ConflictError("workspace name is taken", { code: "workspace_name_taken" });
  }
  const body = (await response.json().catch(() => null)) as { organization?: OrgSummary } | null;
  if (!response.ok || !body?.organization) {
    throw new ServiceUnavailableError("auth service failed to provision the organization", {
      code: "auth_lookup_failed",
      details: { status: response.status },
    });
  }
  return body.organization;
}

/** Compensating delete for provisionOrg. Best-effort: callers catch failures. */
export async function deleteOrg(env: Env, slug: string): Promise<void> {
  await env.AUTH.fetch(`${INTERNAL_ORIGIN}/internal/orgs/${encodeURIComponent(slug)}`, {
    method: "DELETE",
    headers: internalHeaders(),
  });
}

/** Whether the user has a linked GitHub account (self-serve gate). */
export async function isGithubLinked(env: Env, userId: string): Promise<boolean> {
  const response = await env.AUTH.fetch(
    `${INTERNAL_ORIGIN}/internal/users/${encodeURIComponent(userId)}/github-linked`,
    { headers: internalHeaders() },
  );
  if (!response.ok) {
    throw new ServiceUnavailableError("auth service returned an unexpected status", {
      code: "auth_lookup_failed",
      details: { status: response.status },
    });
  }
  const body = (await response.json().catch(() => null)) as { githubLinked?: boolean } | null;
  return body?.githubLinked === true;
}
```

Add `ConflictError` to the `@uploads/errors` import at the top of the file.

- [ ] **Step 4: Implement the route** `apps/api/src/routes/workspaces.ts`:

```ts
/**
 * POST /v1/workspaces (spec 2026-07-14): self-serve workspace creation.
 * Session-authed; requires a GitHub-linked account; creates the backing org
 * (with the caller as owner) over the AUTH binding, then writes the KV
 * ws:<name> record with the self-serve limit template. Org first, KV second,
 * with a compensating org delete when the KV write fails.
 */
import { ConflictError, ForbiddenError, RateLimitedError, ValidationError } from "@uploads/errors";
import { Hono } from "hono";
import { allowWrite } from "../guards";
import { deleteOrg, isGithubLinked, membershipsForUser, provisionOrg } from "../org-workspaces";
import { selfServeWorkspaceRecord } from "../self-serve-defaults";
import { requireSessionUser, sessionAuth, type SessionVars } from "../session-auth";
import { validateSlug } from "../slug-policy";
import { loadWorkspaceRecord } from "../workspace";

const MAX_BODY_BYTES = 1024;
export const MAX_SELF_SERVE_WORKSPACES = 3;

export const workspaces = new Hono<SessionVars>().post(
  "/",
  sessionAuth,
  requireSessionUser,
  async (c) => {
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength > MAX_BODY_BYTES) {
      throw new ValidationError("request body too large", { code: "invalid_request" });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new ValidationError("request body must be valid JSON", { code: "invalid_request" });
    }
    const name =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? String((parsed as Record<string, unknown>).name ?? "").trim()
        : "";

    const verdict = validateSlug(name);
    if (!verdict.ok) {
      throw new ValidationError("workspace name is invalid or unavailable", {
        code: verdict.code,
      });
    }

    const user = c.get("sessionUser")!;

    if (!(await isGithubLinked(c.env, user.id))) {
      throw new ForbiddenError("connect a GitHub account to create workspaces", {
        code: "github_required",
      });
    }

    // Same WRITE_LIMITER other mutating routes use, keyed per user so one
    // account can't hammer creation while others stay unaffected.
    if (!(await allowWrite(c.env, `wscreate:${user.id}`))) {
      throw new RateLimitedError("workspace creation rate limit exceeded");
    }

    // Cap counts only self-serve workspaces the user OWNS — BYO/operator
    // workspaces (no selfServe flag) never burn the allowance.
    const memberships = await membershipsForUser(c.env, user.id);
    const owned = memberships.filter((m) => m.role === "owner");
    const records = await Promise.all(
      owned.map((m) => loadWorkspaceRecord(c.env, m.organizationSlug)),
    );
    const selfServeCount = records.filter((r) => r?.selfServe === true).length;
    if (selfServeCount >= MAX_SELF_SERVE_WORKSPACES) {
      throw new ForbiddenError(`workspace limit reached (${MAX_SELF_SERVE_WORKSPACES})`, {
        code: "workspace_cap_reached",
      });
    }

    // Direct KV read (no cacheTtl) — a 60s-stale cached miss here could let a
    // just-taken name through to the org 409 instead, which is fine, but a
    // stale HIT must not block a genuinely free name.
    const existing = await c.env.REGISTRY.get(`ws:${name}`);
    if (existing !== null) {
      throw new ConflictError("workspace name is taken", { code: "workspace_name_taken" });
    }

    // Org first (owns uniqueness via UNIQUE slug), KV second, compensate on failure.
    await provisionOrg(c.env, { slug: name, ownerUserId: user.id });
    const record = selfServeWorkspaceRecord({ name, userId: user.id, now: new Date() });
    try {
      await c.env.REGISTRY.put(`ws:${name}`, JSON.stringify(record));
    } catch (err) {
      // Best-effort rollback; if this also fails the org is inert (no KV
      // record → no storage access) and an admin can clean it up.
      await deleteOrg(c.env, name).catch(() => {});
      throw err;
    }

    return c.json(
      { workspace: { name, publicBaseUrl: record.publicBaseUrl, selfServe: true } },
      201,
    );
  },
);
```

Mount in `apps/api/src/index.ts`: add `import { workspaces } from "./routes/workspaces";` and insert `.route("/v1/workspaces", workspaces)` directly after `.route("/v1/tokens", tokens)`.

- [ ] **Step 5: Run to verify pass.** `pnpm --filter @uploads/api test -- routes/workspaces`, then the full `pnpm --filter @uploads/api test`. Expect PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/api/src/routes/workspaces.ts apps/api/src/routes/workspaces.test.ts apps/api/src/org-workspaces.ts apps/api/src/index.ts
git commit -m "feat(api): self-serve workspace creation via POST /v1/workspaces"
```

---

### Task 5: Web API client helper

**Files:**

- Modify: `apps/web/src/lib/api-client.ts` (add `createWorkspace`)
- Test: `apps/web/src/lib/api-client.test.ts` if the file exists — check first; if the lib has no test setup, verification is the typecheck + Task 6's manual pass (note it in the commit body).

**Interfaces:**

- Consumes: the endpoint contract from Task 4; the file's existing `trimOrigin`/`fetchWithTimeout` internals and discriminated-union result style (mirror `inviteToWorkspace`).
- Produces:

```ts
export type CreateWorkspaceResult =
  | { kind: "created"; workspace: { name: string; publicBaseUrl?: string } }
  | { kind: "error"; code: string; message: string }
  | { kind: "unavailable" };
export async function createWorkspace(
  apiOrigin: string,
  name: string,
): Promise<CreateWorkspaceResult>;
```

- [ ] **Step 1: Implement** in `apps/web/src/lib/api-client.ts`, after `inviteToWorkspace`, matching its style exactly:

```ts
/** POST /v1/workspaces — self-serve workspace creation (session cookie auth). */
export async function createWorkspace(
  apiOrigin: string,
  name: string,
): Promise<CreateWorkspaceResult> {
  try {
    const response = await fetchWithTimeout(`${trimOrigin(apiOrigin)}/v1/workspaces`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const body = (await response.json().catch(() => null)) as {
      workspace?: { name: string; publicBaseUrl?: string };
      error?: { code?: string; message?: string };
    } | null;
    if (response.ok && body?.workspace) {
      return { kind: "created", workspace: body.workspace };
    }
    return {
      kind: "error",
      code: body?.error?.code ?? "unknown",
      message: body?.error?.message ?? "workspace creation failed",
    };
  } catch {
    return { kind: "unavailable" };
  }
}
```

(Adapt the error-body shape to whatever `respondError` actually emits — check one existing helper's parsing, e.g. `inviteToWorkspace`, and match it.)

- [ ] **Step 2: Verify.** `pnpm --filter @uploads/web types` (or the repo's web typecheck command) — expect clean.

- [ ] **Step 3: Commit.**

```bash
git add apps/web/src/lib/api-client.ts
git commit -m "feat(web): createWorkspace API client helper"
```

---

### Task 6: Web create-workspace UI on /account/workspaces

**Files:**

- Modify: `apps/web/src/pages/account/workspaces.astro` (replace the invite-only note at lines 14–17 and the empty state at 178–182)
- Modify: `apps/web/src/pages/account/profile.astro` (empty state at ~212–214 gets a link to `/account/workspaces#create`)

**Interfaces:**

- Consumes: `createWorkspace` from Task 5; the page's existing `onSession`, `apiOrigin` global, `loadWorkspaces()` structure; error codes from the Global Constraints contract.
- Produces: user-visible create flow; no new exports.

- [ ] **Step 1: Add the create form markup** in `workspaces.astro`. Replace the "Workspaces aren't created from this page" note (lines 14–17) with a create section (match the page's existing card/section classes — copy the invite form's structure at lines 198–212):

```html
<section id="create" data-create-workspace hidden>
  <h2>Create a workspace</h2>
  <p>
    Workspaces get a folder in the shared uploads bucket. Files you upload get
    <strong>public, unguessable URLs</strong> under <code>storage.uploads.sh/&lt;name&gt;/…</code> —
    made for embedding in PRs and issues. Free workspaces start at 1&nbsp;GB storage, 25&nbsp;MB per
    file.
  </p>
  <form data-create-form>
    <input
      name="name"
      required
      pattern="[a-z0-9][a-z0-9-]{1,62}"
      placeholder="workspace-name"
      autocomplete="off"
    />
    <button type="submit">Create workspace</button>
  </form>
  <p data-create-error hidden></p>
  <p data-create-github hidden>
    Creating a workspace requires a linked GitHub account.
    <a href="/account/profile">Connect GitHub on your profile</a>, then come back.
  </p>
</section>
```

- [ ] **Step 2: Wire the script.** In the page's inline script (inside the existing `onSession` flow):

```ts
import { createWorkspace } from "../../lib/api-client";

const createSection = document.querySelector<HTMLElement>("[data-create-workspace]");
const createForm = document.querySelector<HTMLFormElement>("[data-create-form]");
const createError = document.querySelector<HTMLElement>("[data-create-error]");
const createGithub = document.querySelector<HTMLElement>("[data-create-github]");

function showCreateSection(prefill?: string) {
  if (!createSection) return;
  createSection.hidden = false;
  const input = createForm?.elements.namedItem("name") as HTMLInputElement | null;
  if (input && prefill && !input.value) input.value = prefill;
}

createForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (createError) createError.hidden = true;
  if (createGithub) createGithub.hidden = true;
  const input = createForm.elements.namedItem("name") as HTMLInputElement;
  const button = createForm.querySelector("button");
  if (button) button.disabled = true;
  const result = await createWorkspace(apiOrigin, input.value.trim());
  if (button) button.disabled = false;
  if (result.kind === "created") {
    await loadWorkspaces(); // re-render the list with the new workspace
    return;
  }
  if (result.kind === "error" && result.code === "github_required") {
    if (createGithub) createGithub.hidden = false;
    return;
  }
  if (createError) {
    createError.textContent =
      result.kind === "unavailable"
        ? "The API is unreachable right now — try again shortly."
        : createErrorCopy(result.code);
    createError.hidden = false;
  }
});

function createErrorCopy(code: string): string {
  switch (code) {
    case "invalid_workspace_name":
      return "That name isn't available. Use 2–63 lowercase letters, digits, or hyphens, and try a different word.";
    case "reserved_workspace_name":
      return "That name is reserved — pick another.";
    case "workspace_name_taken":
      return "That name is taken — pick another.";
    case "workspace_cap_reached":
      return "You've reached the workspace limit for this account.";
    default:
      return "Workspace creation failed — try again.";
  }
}
```

Show the section always for signed-in users (call `showCreateSection()` after `loadWorkspaces()` resolves). In the zero-workspaces branch (lines 178–182), replace the "accept an invite" copy with: `"No workspaces yet — create one below, or accept an invite to join an existing one."` and call `showCreateSection(suggestedName)` where `suggestedName` is derived from the session user: sanitize `user.email.split("@")[0]` through `name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63)`.

- [ ] **Step 3: Update profile empty state.** In `profile.astro` (~line 212–214) change the copy to: `No workspaces yet — <a href="/account/workspaces#create">create one</a> or accept an invite.`

- [ ] **Step 4: Verify manually.** Run the web dev server per `.claude/launch.json` / `docs` conventions (note the repo memory: apps/web dev uses PROD API origins without local `.dev.vars` — a signed-in prod session cookie is needed to exercise the flow end-to-end; at minimum verify signed-out rendering, form validation, and that submit fires `POST https://api.uploads.sh/v1/workspaces` in the network tab). Typecheck: `pnpm --filter @uploads/web types`.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/pages/account/workspaces.astro apps/web/src/pages/account/profile.astro
git commit -m "feat(web): create-workspace flow on /account/workspaces"
```

---

### Task 7: CLI — offer workspace creation on zero-workspace login

**Files:**

- Modify: `packages/uploads/src/commands/login.ts` (`resolveMintWorkspace`, lines ~286–301, and its call site in `runDeviceLogin`)
- Modify: `packages/uploads/src/client.ts` or the login module (add `createWorkspaceRequest`)
- Test: `packages/uploads/src/commands/login.test.ts` (extend; follow the file's existing stubbing style — read it first)

**Interfaces:**

- Consumes: Task 4's endpoint contract; existing `listMintWorkspaces`, `mintWorkspaceToken`, `UsageError`.
- Produces: `createWorkspaceRequest(apiUrl: string, accessToken: string, name: string): Promise<{ name: string }>` (throws `UsageError` with the server's message on 4xx); interactive create prompt in the zero-workspace path.

- [ ] **Step 1: Write failing tests** covering: (a) zero workspaces + non-interactive (`!process.stdin.isTTY` or the file's existing interactivity flag) → `UsageError` whose message now says `no workspace access yet — create one with a name, or ask an administrator for an invitation` and mentions re-running `uploads login`; (b) zero workspaces + interactive + user enters a name → `createWorkspaceRequest` called, then flow proceeds to mint for that name; (c) server 403 `github_required` → `UsageError` telling the user to connect GitHub at `https://uploads.sh/account/profile` and re-run. Follow the existing login test file's mocking approach for HTTP and stdin.

- [ ] **Step 2: Run to verify failure.** `pnpm --filter uploads test -- login` — FAIL.

- [ ] **Step 3: Implement.** Add the HTTP helper (same module as `listMintWorkspaces`, matching its fetch/error style):

```ts
export async function createWorkspaceRequest(
  apiUrl: string,
  accessToken: string,
  name: string,
): Promise<{ name: string }> {
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}/v1/workspaces`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name }),
  });
  const body = (await response.json().catch(() => null)) as {
    workspace?: { name: string };
    error?: { code?: string; message?: string };
  } | null;
  if (response.ok && body?.workspace) return { name: body.workspace.name };
  if (body?.error?.code === "github_required") {
    throw new UsageError(
      "creating a workspace requires a linked GitHub account — connect one at https://uploads.sh/account/profile and re-run `uploads login`",
    );
  }
  throw new UsageError(body?.error?.message ?? "workspace creation failed");
}
```

In `resolveMintWorkspace`'s zero-workspace branch (replacing the throw at lines 294–298): when interactive, prompt via `node:readline/promises` (or the file's existing prompt helper if one exists — check for one first):

```ts
if (workspaces.length === 0) {
  if (!interactive) {
    throw new UsageError(
      "your account has no workspace access yet — run `uploads login` interactively to create one, or ask an administrator for an invitation",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const name = (
      await rl.question("no workspaces yet — enter a name to create one (lowercase, hyphens): ")
    ).trim();
    if (!name) throw new UsageError("workspace creation cancelled");
    const created = await createWorkspaceRequest(apiUrl, accessToken, name);
    process.stderr.write(
      `created workspace "${created.name}" — files will get public URLs under https://storage.uploads.sh/${created.name}/\n`,
    );
    return created.name;
  } finally {
    rl.close();
  }
}
```

(Adapt parameter plumbing: `resolveMintWorkspace` needs `accessToken` and an `interactive` flag if it doesn't already receive them — thread from `runDeviceLogin`.)

- [ ] **Step 4: Run to verify pass.** `pnpm --filter uploads test -- login`, then the package's full test suite. PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/uploads/src/commands/login.ts packages/uploads/src/client.ts packages/uploads/src/commands/login.test.ts
git commit -m "feat(cli): offer workspace creation when login finds no workspaces"
```

---

### Task 8: Documentation

**Files:**

- Modify: `docs/workspaces.md` (new "Self-serve workspaces" section: how creation works, limits table, public-URL disclosure, cap, that raises are admin-only)
- Modify: `docs/enrollment.md` (add the self-serve path alongside invitations/enrollment codes; note GitHub requirement)
- Modify: `docs/roadmap.md` (mark self-serve registration shipped; keep "private storage tier" as the deferred follow-up)

**Interfaces:** none (prose only). Content requirements: document the exact limits from Global Constraints, the `POST /v1/workspaces` error codes, and the reserved-names + blocklist behavior (mention the blocklist exists; do not enumerate it).

- [ ] **Step 1: Write the doc updates** per the content requirements above, matching each file's existing tone and structure.
- [ ] **Step 2: Commit.**

```bash
git add docs/workspaces.md docs/enrollment.md docs/roadmap.md
git commit -m "docs: self-serve workspace registration"
```

---

## Post-merge verification (coordinating session, production)

After deploy: GitHub sign-up with a fresh account → `/account/workspaces` create → `uploads login` → `uploads put` a PNG → fetch the public URL → confirm limits appear in `GET /me/workspaces/<name>/usage`. Also verify a magic-link-only account gets the `github_required` path in both web and CLI.
