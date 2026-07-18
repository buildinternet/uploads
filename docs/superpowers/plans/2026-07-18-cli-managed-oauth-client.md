# CLI Managed OAuth Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the CLI device-flow login from a hardcoded static client id to a seeded, managed `oauth_client` registration (public PKCE, `official: true`), and replace the string-equality special case in the authorization server with a real DB lookup (issue #251).

**Architecture:** Keep the client id literal `uploads-cli` (so already-configured CLIs keep working — nothing changes on the wire), but seed it as a real row in the auth worker's `oauth_client` table via an idempotent D1 migration. The `deviceAuthorization` plugin's `validateClient` hook (which supports `Promise<boolean>`, verified in better-auth 1.6.23 `dist/plugins/device-authorization/routes.mjs:87-92,181-186`) switches from `clientId === "uploads-cli"` to a Drizzle lookup that requires the row to exist, be enabled, and carry the device-code grant type. The seeded row then appears in the `/admin/oauth` panel with the official badge and a working disable toggle.

**Tech Stack:** Cloudflare Workers, D1 (raw SQL migrations in `apps/auth/migrations/`), Drizzle ORM, better-auth 1.6.23 `deviceAuthorization` plugin, Vitest with in-memory fake D1 (`apps/auth/src/test/fake-d1.ts` — `applyMigrations()` globs the migrations dir, so the seed row appears in tests automatically).

## Global Constraints

- Client id stays exactly `uploads-cli` — the CLI (`packages/uploads/src/client.ts:313` `DEVICE_CLIENT_ID`) is NOT changed; no CLI-side code changes in this plan.
- Migration file naming: `YYYYMMDDHHMMSS_description.sql` in `apps/auth/migrations/`; must be idempotent (`INSERT OR IGNORE`) so re-applies and pre-seeded environments are safe.
- The seeded row mirrors the admin-panel creation shape (`apps/auth/src/internal-routes.ts:731-752`): `client_secret NULL`, `token_endpoint_auth_method 'none'`, `public 1`, `require_pkce 1`, `disabled 0`, `skip_consent 0`, `user_id NULL` — except `grant_types` is `["urn:ietf:params:oauth:grant-type:device_code"]`, `redirect_uris` is `[]` (device flow has no redirects), and `metadata` is `{"official":true}`.
- Fail-closed posture must be preserved: unknown client ids, disabled clients, and registered clients WITHOUT the device-code grant type must all be rejected on both `/api/auth/device/code` and `/api/auth/device/token`.
- Tests: run from `apps/auth` with `pnpm vitest run src/device.test.ts` (plain vitest + fake D1; no pool-workers).
- Commit messages: conventional commits, no sensational adjectives.
- Deploy ordering (PR description note, not code): `pnpm migrate:d1` in `apps/auth` must run before or with the worker deploy — the new `validateClient` fails closed if the row is missing.

## File Structure

- Create: `apps/auth/migrations/20260719000000_seed_cli_oauth_client.sql` — idempotent seed of the `uploads-cli` client row.
- Modify: `apps/auth/src/auth.ts` — remove `UPLOADS_CLI_CLIENT_ID` export + its comment block (lines 39-47); replace `validateClient` (line 321) with a DB lookup; add exported helper `isDeviceFlowClientAllowed`; update the comment block at lines 310-314.
- Modify: `apps/auth/src/device.test.ts` — drop the `UPLOADS_CLI_CLIENT_ID` import (use a local `CLI_CLIENT_ID = "uploads-cli"` constant); add negative tests (disabled client, registered-but-no-device-grant client) and a seed-row assertion.
- Modify: `packages/uploads/src/client.ts` — doc comment only (lines ~305-313) describing the managed registration.
- Modify: `docs/enrollment.md` — device-flow section + migration notes mention the managed client.

---

### Task 1: Seed migration for the `uploads-cli` client

**Files:**

- Create: `apps/auth/migrations/20260719000000_seed_cli_oauth_client.sql`
- Test: `apps/auth/src/device.test.ts` (new test appended)

**Interfaces:**

- Produces: an `oauth_client` row with `client_id = 'uploads-cli'`, `disabled = 0`, `grant_types = '["urn:ietf:params:oauth:grant-type:device_code"]'`, `metadata = '{"official":true}'` — Task 2's `validateClient` lookup depends on exactly these values.

- [ ] **Step 1: Write the failing test**

Append to `apps/auth/src/device.test.ts` (reuse the existing `dbEnv()` helper and drizzle imports already in the file; add `oauthClient` to the existing schema import if not present):

```ts
describe("seeded CLI oauth client (issue #251)", () => {
  it("migrations seed an official, enabled uploads-cli client", async () => {
    const { env } = dbEnv();
    const db = drizzle(env.DB, { schema });
    const [row] = await db
      .select()
      .from(schema.oauthClient)
      .where(eq(schema.oauthClient.clientId, "uploads-cli"))
      .limit(1);
    expect(row).toBeDefined();
    expect(row.disabled).toBe(false);
    expect(row.public).toBe(true);
    expect(row.requirePKCE).toBe(true);
    expect(row.clientSecret).toBeNull();
    expect(row.grantTypes).toEqual(["urn:ietf:params:oauth:grant-type:device_code"]);
    expect(row.metadata).toEqual({ official: true });
  });
});
```

(Adapt the exact `dbEnv()`/drizzle call shape to what the top of the file already does — the file already constructs a drizzle instance for `seedSignedInUser`; follow that pattern verbatim. If the drizzle JSON columns come back as strings in this test context, match the file's existing deserialization behavior rather than fighting it.)

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/auth`): `pnpm vitest run src/device.test.ts -t "seeded"`
Expected: FAIL — `row` is undefined (no seed migration yet).

- [ ] **Step 3: Write the migration**

Create `apps/auth/migrations/20260719000000_seed_cli_oauth_client.sql`:

```sql
-- Issue #251: the CLI's device-flow client becomes a managed oauth_client
-- registration instead of a string-allowlisted static id. The client_id stays
-- 'uploads-cli' so already-configured CLIs keep working. Shape mirrors the
-- admin panel's POST /internal/oauth-clients insert (public PKCE, no secret),
-- except: grant_types carries the RFC 8628 device grant, redirect_uris is
-- empty (device flow has no redirects), and metadata marks it official.
-- Idempotent: INSERT OR IGNORE keys off the client_id UNIQUE constraint.
INSERT OR IGNORE INTO oauth_client (
  id, client_id, client_secret, name, redirect_uris, scopes,
  grant_types, response_types, token_endpoint_auth_method, type,
  public, require_pkce, disabled, skip_consent, user_id, metadata,
  created_at, updated_at
) VALUES (
  'oc_uploads_cli_seed',
  'uploads-cli',
  NULL,
  'Uploads CLI',
  '[]',
  '["files:read","files:write","files:delete"]',
  '["urn:ietf:params:oauth:grant-type:device_code"]',
  '[]',
  'none',
  'web',
  1, 1, 0, 0,
  NULL,
  '{"official":true}',
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  CAST(strftime('%s','now') AS INTEGER) * 1000
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/device.test.ts -t "seeded"`
Expected: PASS. Then run the full file — `pnpm vitest run src/device.test.ts` — expected: all existing tests still pass (the seed row is inert while `validateClient` is still the string check).

Also run `pnpm vitest run src/internal-oauth-clients.test.ts` — the admin CRUD tests must still pass with the extra seeded row present (if a test asserts an exact list length from a clean DB, adjust that test to account for the seeded row, and say so in the report).

- [ ] **Step 5: Commit**

```bash
git add apps/auth/migrations/20260719000000_seed_cli_oauth_client.sql apps/auth/src/device.test.ts
git commit -m "feat(auth): seed uploads-cli as a managed official oauth_client (#251)"
```

---

### Task 2: Replace the static-id allowlist with a DB lookup

**Files:**

- Modify: `apps/auth/src/auth.ts` (remove lines 39-47 constant+comment; replace `validateClient` at line 321; revise comment block at lines 310-314)
- Modify/Test: `apps/auth/src/device.test.ts`

**Interfaces:**

- Consumes: the seeded row from Task 1 (`client_id = 'uploads-cli'`, `disabled`, `grantTypes` JSON including `urn:ietf:params:oauth:grant-type:device_code`).
- Produces: exported `async function isDeviceFlowClientAllowed(db, clientId): Promise<boolean>` in `apps/auth/src/auth.ts` (exported for direct unit testing, same rationale as the existing `resolveWorkspaceClaims` export). `UPLOADS_CLI_CLIENT_ID` no longer exists — nothing else in the repo imports it except `device.test.ts` (verified in exploration).

- [ ] **Step 1: Update tests first**

In `apps/auth/src/device.test.ts`:

1. Remove `UPLOADS_CLI_CLIENT_ID` from the `./auth` import; add a file-local `const CLI_CLIENT_ID = "uploads-cli";` and substitute it at the former usage sites (previously lines 41, 118, 158, 171, 182).
2. Add new tests (reuse `dbEnv()` and the file's request-driving pattern against the real Hono `app` — mirror the existing "unknown client id" negative tests at lines ~66-83):

```ts
describe("validateClient DB lookup (issue #251)", () => {
  it("rejects device/code for a disabled client", async () => {
    const { env } = dbEnv();
    const db = drizzle(env.DB, { schema });
    await db
      .update(schema.oauthClient)
      .set({ disabled: true })
      .where(eq(schema.oauthClient.clientId, CLI_CLIENT_ID));
    const res = await postDeviceCode(env, CLI_CLIENT_ID); // use the file's existing request helper/pattern
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_client");
  });

  it("rejects device/code for a registered client without the device-code grant", async () => {
    const { env } = dbEnv();
    const db = drizzle(env.DB, { schema });
    await db.insert(schema.oauthClient).values({
      id: "oc_authcode_only",
      clientId: "authcode-only",
      redirectUris: ["https://example.com/cb"],
      scopes: ["files:read"],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none",
      public: true,
      requirePKCE: true,
      disabled: false,
      skipConsent: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await postDeviceCode(env, "authcode-only");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_client");
  });
});
```

(`postDeviceCode` stands for however the existing tests POST `/api/auth/device/code` — reuse that exact mechanism; do not invent a new helper if an inline pattern exists, but extracting a tiny local helper to avoid triplicating the fetch is fine.)

The existing "unknown client id → invalid_client / invalid_grant" tests stay as-is — they now exercise the lookup path instead of the string compare.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm vitest run src/device.test.ts`
Expected: the two new tests FAIL (disabled/no-grant clients are currently accepted or rejected for the wrong reason — the string check rejects `authcode-only` today with the right error, so specifically the "disabled client" test must fail; if the no-grant test passes trivially under the old code, that's expected and it becomes meaningful after Step 3).

- [ ] **Step 3: Implement the lookup**

In `apps/auth/src/auth.ts`:

Delete lines 39-47 (the comment block and `export const UPLOADS_CLI_CLIENT_ID = "uploads-cli";`). In their place add:

```ts
/**
 * RFC 8628 device-flow client gate (issue #251). The CLI's client id
 * (`uploads-cli`, seeded by migration 20260719000000 as a managed official
 * oauth_client row) is no longer a string allowlist: any registered, enabled
 * client whose grant_types include the device-code grant may start a device
 * flow. Fail-closed — a missing row, a disabled toggle (admin panel
 * /admin/oauth), or an absent grant type all reject. Exported for direct unit
 * testing (device.test.ts).
 */
export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export async function isDeviceFlowClientAllowed(
  db: ReturnType<typeof drizzle<typeof schema>>,
  clientId: string,
): Promise<boolean> {
  const [row] = await db
    .select({
      disabled: schema.oauthClient.disabled,
      grantTypes: schema.oauthClient.grantTypes,
    })
    .from(schema.oauthClient)
    .where(eq(schema.oauthClient.clientId, clientId))
    .limit(1);
  if (!row || row.disabled) return false;
  return Array.isArray(row.grantTypes) && row.grantTypes.includes(DEVICE_CODE_GRANT);
}
```

(If `schema.oauthClient.grantTypes` deserializes to a string rather than an array in this Drizzle config, parse it with a try/catch `JSON.parse` and treat unparseable as `false` — check `apps/auth/src/schema.ts:278-313` for the column mode and match `internal-routes.ts`'s handling.)

Then replace line 321:

```ts
        validateClient: (clientId) => clientId === UPLOADS_CLI_CLIENT_ID,
```

with:

```ts
        validateClient: (clientId) => isDeviceFlowClientAllowed(db, clientId),
```

And rewrite the comment block at lines 310-314 to:

```ts
// validateClient is fail-closed against the oauth_client table: the id
// must be registered, enabled, and carry the device-code grant type
// (issue #251 — the CLI's `uploads-cli` id is a seeded managed row, so
// the admin panel's disable toggle now actually gates the device flow).
// Without validateClient the plugin accepts ANY client_id.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/device.test.ts`
Expected: PASS, all tests including the pre-existing happy-path device flow (which now passes via the seeded row) and both negative suites.

Then run the worker's full suite from `apps/auth`: `pnpm test` (or the package's test script) — expected: PASS. Also run `pnpm typecheck` if the package has it (a removed export must not break other imports; exploration found none outside device.test.ts, verify with `grep -rn "UPLOADS_CLI_CLIENT_ID" --include="*.ts" .` from the repo root — expect zero hits after this step).

- [ ] **Step 5: Commit**

```bash
git add apps/auth/src/auth.ts apps/auth/src/device.test.ts
git commit -m "feat(auth): gate device flow on registered oauth_client rows (#251)"
```

---

### Task 3: Documentation and in-code comment updates

**Files:**

- Modify: `packages/uploads/src/client.ts` (doc comment above `DEVICE_CLIENT_ID`, ~lines 305-313 — comment only, no code change)
- Modify: `docs/enrollment.md`

**Interfaces:**

- Consumes: the design shipped in Tasks 1-2 (seeded managed client, DB-lookup gate). No produced interfaces.

- [ ] **Step 1: Update the CLI-side doc comment**

In `packages/uploads/src/client.ts`, replace the doc comment immediately above `export const DEVICE_CLIENT_ID = "uploads-cli";` with (keep the constant itself unchanged):

```ts
/**
 * OAuth client id for the device flow. Registered server-side as a managed
 * official `oauth_client` row (seeded by apps/auth migration
 * 20260719000000_seed_cli_oauth_client.sql — issue #251): public PKCE client,
 * no secret, device-code grant only. The auth worker's device endpoints
 * validate this id against that table, so operators can disable it from
 * /admin/oauth. The literal must match the seeded row's client_id.
 */
```

(Adapt the replacement to whatever the current comment's exact text is — the intent: it must no longer describe a "static allowlisted id" design.)

- [ ] **Step 2: Update docs/enrollment.md**

In the "Everyday login (device flow)" section, add one sentence noting the CLI authenticates as the managed official OAuth client `uploads-cli`, visible and toggleable in the operator admin panel at `/admin/oauth`. In the "Migration notes" section (lines ~130-143), note that migration `20260719000000_seed_cli_oauth_client.sql` seeds this client and must be applied (`pnpm migrate:d1` in `apps/auth`) before deploying an auth worker that includes the DB-backed `validateClient` — the device flow fails closed without the row.

- [ ] **Step 3: Verify no stale references**

Run from repo root: `grep -rn "static.*client id\|allowlisted id" docs packages/uploads/src apps/auth/src --include="*.ts" --include="*.md" | grep -iv node_modules`
Expected: no remaining descriptions of the old static-allowlist design (test fixtures using the literal `uploads-cli` are fine).

- [ ] **Step 4: Commit**

```bash
git add packages/uploads/src/client.ts docs/enrollment.md
git commit -m "docs: describe managed uploads-cli oauth client registration (#251)"
```
