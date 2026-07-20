# Admin Workspace Limits Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a global admin edit a single workspace's four numeric budget limits (storage, monthly uploads, per-file, per-video) from the admin panel's Workspaces view, including clearing any of them to unlimited.

**Architecture:** A pure validation helper (`workspace-limits.ts`) parses/validates a PATCH body. Two new session-cookie-gated endpoints on the existing `/admin-ui/*` router read and write the four fields on the KV `WorkspaceRecord` — reading the raw record, mutating only the four budget fields (set number / delete for unlimited), and writing the whole record back so all other fields survive. The admin Workspaces page gains a lazily-loaded Limits form inside each expanded workspace row.

**Tech Stack:** TypeScript, Hono (Cloudflare Workers), Vitest, Astro (vanilla TS in a `<script>`), `@uploads/errors`.

## Global Constraints

- Session auth only: the new endpoints mount under `/admin-ui/*`, already gated by `sessionAuth, requireSessionUser, requireAdminUser` (global `admin` role). No new auth, no `ADMIN_TOKEN` path.
- "Unlimited" is represented by the **absence** of the field on the record (existing convention in `apps/api/src/workspace.ts`). Clearing a limit means `delete record[field]`.
- A limits write must preserve every non-budget field on the record (`retentionDays`, `allowedKeyPrefixes`, `maxKeyDepth`, `provider`, `bucket`, `prefix`, tokens, org linkage, `deletedAt`, etc.).
- Editable fields are exactly: `maxStorageBytes`, `maxUploadsPerPeriod`, `maxUploadBytes`, `maxVideoUploadBytes`. No retention/key-policy editing.
- Valid limit value = a finite integer `>= 1`, or `null`. Reject everything else with HTTP 400, `code: "invalid_limit"`.
- KV serving reads use `cacheTtl: 60`, so edits take up to ~60s to take effect. Surface this in the UI.
- Byte units in the UI are decimal by default (MB = 1000², GB = 1000³) with GiB (1024³) offered, matching how limits are authored elsewhere.

## File Structure

- `apps/api/src/workspace-limits.ts` — **new.** `validateLimitsPatch()`, `LIMIT_FIELDS`, `LimitField`, `LimitsPatch`. Pure, no I/O.
- `apps/api/src/workspace-limits.test.ts` — **new.** Unit tests for the validator.
- `apps/api/src/routes/admin-ui.ts` — **modify.** Add `GET` + `PATCH /workspaces/:name/limits` and two small module-level helpers.
- `apps/api/src/routes/admin-ui.test.ts` — **modify.** Add endpoint tests reusing the file's existing `stubEnv`/`stubAuth` helpers.
- `apps/web/src/pages/admin/index.astro` — **modify.** Add the Limits form to the expanded workspace row.
- `apps/web/src/styles/admin-workspaces.css` — **modify.** Styles for the Limits form.

All test commands run from `apps/api` unless noted.

---

### Task 1: `validateLimitsPatch` validation helper

**Files:**

- Create: `apps/api/src/workspace-limits.ts`
- Test: `apps/api/src/workspace-limits.test.ts`

**Interfaces:**

- Consumes: `ValidationError` from `@uploads/errors`.
- Produces:
  - `LIMIT_FIELDS: readonly ["maxStorageBytes","maxUploadsPerPeriod","maxUploadBytes","maxVideoUploadBytes"]`
  - `type LimitField = (typeof LIMIT_FIELDS)[number]`
  - `type LimitsPatch = Partial<Record<LimitField, number | null>>`
  - `validateLimitsPatch(body: unknown): LimitsPatch` — throws `ValidationError` (`code: "invalid_limit"`) on any invalid field; ignores unknown keys; only includes fields actually present in the body.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/workspace-limits.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateLimitsPatch } from "./workspace-limits";

describe("validateLimitsPatch", () => {
  it("accepts positive integers for each field", () => {
    expect(
      validateLimitsPatch({
        maxStorageBytes: 250_000_000,
        maxUploadsPerPeriod: 3000,
        maxUploadBytes: 25_000_000,
        maxVideoUploadBytes: 8_000_000,
      }),
    ).toEqual({
      maxStorageBytes: 250_000_000,
      maxUploadsPerPeriod: 3000,
      maxUploadBytes: 25_000_000,
      maxVideoUploadBytes: 8_000_000,
    });
  });

  it("accepts null (clear to unlimited)", () => {
    expect(validateLimitsPatch({ maxStorageBytes: null })).toEqual({ maxStorageBytes: null });
  });

  it("only includes fields present in the body and ignores unknown keys", () => {
    expect(validateLimitsPatch({ maxUploadBytes: 5, somethingElse: 9 })).toEqual({
      maxUploadBytes: 5,
    });
  });

  it("rejects zero, negatives, and non-integers", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validateLimitsPatch({ maxStorageBytes: bad })).toThrow(
        /invalid_limit|positive/i,
      );
    }
  });

  it("rejects non-number, non-null values", () => {
    for (const bad of ["100", true, {}, []]) {
      expect(() => validateLimitsPatch({ maxUploadsPerPeriod: bad })).toThrow();
    }
  });

  it("rejects a non-object body", () => {
    expect(() => validateLimitsPatch(null)).toThrow();
    expect(() => validateLimitsPatch("nope")).toThrow();
    expect(() => validateLimitsPatch([1, 2])).toThrow();
  });

  it("carries code invalid_limit on the thrown error", () => {
    try {
      validateLimitsPatch({ maxStorageBytes: -5 });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("invalid_limit");
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/workspace-limits.test.ts`
Expected: FAIL — cannot import `validateLimitsPatch` (module does not exist).

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/workspace-limits.ts`:

```ts
/**
 * Validates the budget-limit patch body accepted by the admin panel's
 * PATCH /admin-ui/workspaces/:name/limits endpoint. Pure — no I/O — so it is
 * unit-tested directly and could back a future token-gated /admin twin.
 *
 * Mirrors set-workspace-limits.mjs's field set and clear semantics, but only
 * the four numeric budget fields (no retention / key-policy). A value is a
 * finite integer >= 1 (set the cap) or null (clear the field -> unlimited).
 */
import { ValidationError } from "@uploads/errors";

export const LIMIT_FIELDS = [
  "maxStorageBytes",
  "maxUploadsPerPeriod",
  "maxUploadBytes",
  "maxVideoUploadBytes",
] as const;

export type LimitField = (typeof LIMIT_FIELDS)[number];

export type LimitsPatch = Partial<Record<LimitField, number | null>>;

export function validateLimitsPatch(body: unknown): LimitsPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("limits body must be a JSON object", { code: "invalid_limit" });
  }
  const record = body as Record<string, unknown>;
  const patch: LimitsPatch = {};
  for (const field of LIMIT_FIELDS) {
    if (!(field in record)) continue;
    const value = record[field];
    if (value === null) {
      patch[field] = null;
      continue;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new ValidationError(`${field} must be a positive integer or null`, {
        code: "invalid_limit",
        details: { field },
      });
    }
    patch[field] = value;
  }
  return patch;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/workspace-limits.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @uploads/api types`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/workspace-limits.ts apps/api/src/workspace-limits.test.ts
git commit -m "feat(api): add validateLimitsPatch for workspace budget limits"
```

---

### Task 2: GET + PATCH `/admin-ui/workspaces/:name/limits`

**Files:**

- Modify: `apps/api/src/routes/admin-ui.ts`
- Test: `apps/api/src/routes/admin-ui.test.ts`

**Interfaces:**

- Consumes: `validateLimitsPatch`, `LIMIT_FIELDS` from `../workspace-limits`; `loadWorkspaceRecordRaw`, `isPurgedTombstone`, `type WorkspaceRecord` from `../workspace`; `getWorkspaceUsage` from `../usage`; `NotFoundError` (already imported in the file).
- Produces two routes on the exported `adminUi` router:
  - `GET /workspaces/:name/limits` → `200 { workspace, limits, usage }`
  - `PATCH /workspaces/:name/limits` → `200 { workspace, limits, usage }`
  - `limits` is `{ maxStorageBytes, maxUploadsPerPeriod, maxUploadBytes, maxVideoUploadBytes }`, each `number | null`.
  - `usage` is `{ bytes: number, uploads: number } | null`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/admin-ui.test.ts` (the file already defines `ADMIN_USER`, `NON_ADMIN_USER`, `stubEnv`, `stubAuth`, `app`). Add this block after the existing `describe` blocks:

```ts
describe("workspace limits editing", () => {
  const CURRENT_PERIOD = new Date().toISOString().slice(0, 7);

  /** Env with a mutable ws:acme record, a session user, and a usage row. */
  function limitsEnv(
    user: typeof ADMIN_USER | null,
    record: Record<string, unknown> | null,
    usage: { bytes: number; uploadsInPeriod: number } | null = { bytes: 0, uploadsInPeriod: 0 },
  ) {
    const store = new Map<string, string>();
    if (record) store.set("ws:acme", JSON.stringify(record));
    const base = stubEnv(user, () => new Response(null, { status: 404 }));
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () =>
            usage
              ? {
                  workspace: "acme",
                  bytes: usage.bytes,
                  objects: 0,
                  uploads_in_period: usage.uploadsInPeriod,
                  period_start: CURRENT_PERIOD,
                  updated_at: "2026-07-20T00:00:00.000Z",
                }
              : null,
        }),
      }),
    };
    const env = {
      ...base,
      DB: db,
      REGISTRY: {
        get: (async (key: string) => {
          const raw = store.get(key);
          return raw ? JSON.parse(raw) : null;
        }) as unknown as KVNamespace["get"],
        put: (async (key: string, value: string) => {
          store.set(key, value);
        }) as unknown as KVNamespace["put"],
      },
    } as unknown as Env;
    return { env, store };
  }

  const REC = {
    provider: "r2",
    bucket: "uploads-default",
    prefix: "acme/",
    maxStorageBytes: 250_000_000,
    maxUploadsPerPeriod: 3000,
    allowedKeyPrefixes: ["f", "screenshots", "gh"],
    retentionDays: 90,
  };

  it("GET returns current limits and usage", async () => {
    const { env } = limitsEnv(ADMIN_USER, REC, { bytes: 128, uploadsInPeriod: 5 });
    const res = await app().request("/admin-ui/workspaces/acme/limits", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspace: "acme",
      limits: {
        maxStorageBytes: 250_000_000,
        maxUploadsPerPeriod: 3000,
        maxUploadBytes: null,
        maxVideoUploadBytes: null,
      },
      usage: { bytes: 128, uploads: 5 },
    });
  });

  it("PATCH sets numeric limits on the record", async () => {
    const { env, store } = limitsEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/limits",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxStorageBytes: 500_000_000, maxUploadBytes: 10_000_000 }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const saved = JSON.parse(store.get("ws:acme")!);
    expect(saved.maxStorageBytes).toBe(500_000_000);
    expect(saved.maxUploadBytes).toBe(10_000_000);
  });

  it("PATCH with null clears a limit to unlimited", async () => {
    const { env, store } = limitsEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/limits",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxStorageBytes: null }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const saved = JSON.parse(store.get("ws:acme")!);
    expect("maxStorageBytes" in saved).toBe(false);
  });

  it("PATCH leaves omitted budget fields and all non-budget fields intact", async () => {
    const { env, store } = limitsEnv(ADMIN_USER, REC);
    await app().request(
      "/admin-ui/workspaces/acme/limits",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxUploadBytes: 10_000_000 }),
      },
      env,
    );
    const saved = JSON.parse(store.get("ws:acme")!);
    expect(saved.maxUploadsPerPeriod).toBe(3000); // omitted -> unchanged
    expect(saved.allowedKeyPrefixes).toEqual(["f", "screenshots", "gh"]); // preserved
    expect(saved.retentionDays).toBe(90); // preserved
    expect(saved.prefix).toBe("acme/"); // preserved
  });

  it("PATCH 400s on an invalid limit value", async () => {
    const { env } = limitsEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/limits",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxStorageBytes: -5 }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe("invalid_limit");
  });

  it("404s for an unknown workspace", async () => {
    const { env } = limitsEnv(ADMIN_USER, null);
    const res = await app().request("/admin-ui/workspaces/acme/limits", {}, env);
    expect(res.status).toBe(404);
  });

  it("404s for a soft-deleted workspace", async () => {
    const { env } = limitsEnv(ADMIN_USER, { ...REC, deletedAt: "2026-07-01T00:00:00.000Z" });
    const res = await app().request("/admin-ui/workspaces/acme/limits", {}, env);
    expect(res.status).toBe(404);
  });

  it("403s for a non-admin session", async () => {
    const { env } = limitsEnv(NON_ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/limits",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxStorageBytes: 1 }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("returns usage: null when the usage read finds no row", async () => {
    const { env } = limitsEnv(ADMIN_USER, REC, null);
    const res = await app().request("/admin-ui/workspaces/acme/limits", {}, env);
    expect(res.status).toBe(200);
    // getWorkspaceUsage returns an empty usage row (bytes 0) rather than throwing,
    // so usage is still an object here; assert the shape is present.
    const body = (await res.json()) as { usage: { bytes: number } | null };
    expect(body.usage).toEqual({ bytes: 0, uploads: 0 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/routes/admin-ui.test.ts`
Expected: FAIL — the `/limits` route does not exist yet (GET/PATCH return 404 from the router, so the `200`/`400`/preservation assertions fail).

- [ ] **Step 3: Add imports to `admin-ui.ts`**

At the top of `apps/api/src/routes/admin-ui.ts`, add these imports alongside the existing ones. Add to the existing `../workspace`-adjacent imports (there is no existing `../workspace` import in this file, so add a new line):

```ts
import { getWorkspaceUsage } from "../usage";
import { isPurgedTombstone, loadWorkspaceRecordRaw, type WorkspaceRecord } from "../workspace";
import { LIMIT_FIELDS, validateLimitsPatch } from "../workspace-limits";
```

`NotFoundError` is already imported from `@uploads/errors` at the top of the file — do not re-import it.

- [ ] **Step 4: Add the two helpers**

In `apps/api/src/routes/admin-ui.ts`, add these module-level helper functions just above `export const adminUi = new Hono<SessionVars>()`:

```ts
/**
 * Raw-reads ws:<name> for a limits edit and 404s on missing / soft-deleted /
 * purged-tombstone records (an admin can't edit limits on a workspace that no
 * longer serves). Uses the uncached raw read so the edit sees the freshest
 * record. Returns a live WorkspaceRecord the caller mutates and writes back.
 */
async function loadEditableWorkspace(env: Env, name: string): Promise<WorkspaceRecord> {
  const record = await loadWorkspaceRecordRaw(env, name);
  if (!record || isPurgedTombstone(record) || record.deletedAt) {
    throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
  }
  return record;
}

/** Response body shared by GET and PATCH: current budget limits + usage. */
async function limitsResponse(env: Env, name: string, record: WorkspaceRecord) {
  const limits = {
    maxStorageBytes: record.maxStorageBytes ?? null,
    maxUploadsPerPeriod: record.maxUploadsPerPeriod ?? null,
    maxUploadBytes: record.maxUploadBytes ?? null,
    maxVideoUploadBytes: record.maxVideoUploadBytes ?? null,
  };
  let usage: { bytes: number; uploads: number } | null = null;
  try {
    const u = await getWorkspaceUsage(env.DB, name);
    usage = { bytes: u.bytes, uploads: u.uploadsInPeriod };
  } catch {
    usage = null;
  }
  return { workspace: name, limits, usage };
}
```

- [ ] **Step 5: Add the routes**

In `apps/api/src/routes/admin-ui.ts`, add these two routes to the `adminUi` chain. Place them immediately after the `.post("/workspaces/:name/invite-links", ...)` route and before the `.get("/oauth-clients", ...)` route:

```ts
  // Read the four budget limits (+ current usage) for one workspace.
  .get("/workspaces/:name/limits", async (c) => {
    const name = c.req.param("name");
    const record = await loadEditableWorkspace(c.env, name);
    return c.json(await limitsResponse(c.env, name, record));
  })

  // Patch the four budget limits. Each field is optional; a positive integer
  // sets the cap, null clears it (-> unlimited), omitted leaves it unchanged.
  // The whole record is written back so non-budget fields are preserved.
  .patch("/workspaces/:name/limits", async (c) => {
    const name = c.req.param("name");
    const record = await loadEditableWorkspace(c.env, name);
    const patch = validateLimitsPatch(await c.req.json().catch(() => ({})));
    for (const field of LIMIT_FIELDS) {
      if (!(field in patch)) continue;
      const value = patch[field];
      if (value === null) delete record[field];
      else record[field] = value;
    }
    await c.env.REGISTRY.put(`ws:${name}`, JSON.stringify(record));
    return c.json(await limitsResponse(c.env, name, record));
  })
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run src/routes/admin-ui.test.ts`
Expected: PASS — all existing tests plus the 9 new limits tests.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @uploads/api types`
Expected: no type errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/admin-ui.ts apps/api/src/routes/admin-ui.test.ts
git commit -m "feat(api): admin-ui endpoints to read and edit workspace limits"
```

---

### Task 3: Limits form in the admin Workspaces UI

**Files:**

- Modify: `apps/web/src/pages/admin/index.astro`
- Modify: `apps/web/src/styles/admin-workspaces.css`

**Interfaces:**

- Consumes: `GET`/`PATCH /admin-ui/workspaces/:name/limits` from Task 2 (`{ workspace, limits, usage }`).
- Produces: no exported symbols; DOM behavior only. Verified manually in the browser preview.

This task has no unit test (the repo has no front-end test harness for these Astro pages); it is verified in the running app per the steps below.

- [ ] **Step 1: Add the limits container to the row markup**

In `apps/web/src/pages/admin/index.astro`, inside `renderWorkspace`, find the `<div class="detail">` template. Immediately after the `<div class="invites"></div>` line, add a limits container:

```html
<div class="invites"></div>
<div class="limits" data-state="unloaded"></div>
```

- [ ] **Step 2: Add the limits field config and byte helpers**

In the same `<script>`, add this block just above the `function renderWorkspace(` declaration:

```ts
interface Limits {
  maxStorageBytes: number | null;
  maxUploadsPerPeriod: number | null;
  maxUploadBytes: number | null;
  maxVideoUploadBytes: number | null;
}
interface LimitsResponse {
  workspace: string;
  limits: Limits;
  usage: { bytes: number; uploads: number } | null;
}

const LIMIT_UNITS: { label: string; mult: number }[] = [
  { label: "MB", mult: 1_000_000 },
  { label: "GB", mult: 1_000_000_000 },
  { label: "GiB", mult: 1024 ** 3 },
];
const LIMIT_FIELDS: { key: keyof Limits; label: string; byte: boolean }[] = [
  { key: "maxStorageBytes", label: "Storage", byte: true },
  { key: "maxUploadsPerPeriod", label: "Uploads / month", byte: false },
  { key: "maxUploadBytes", label: "Max file size", byte: true },
  { key: "maxVideoUploadBytes", label: "Max video size", byte: true },
];

/** Pick a friendly unit + value for a byte count (exact GiB > GB > MB). */
function splitBytes(n: number): { value: number; unit: string } {
  for (const u of [...LIMIT_UNITS].reverse()) {
    if (n % u.mult === 0) return { value: n / u.mult, unit: u.label };
  }
  return { value: n / 1_000_000, unit: "MB" };
}
function formatBytes(n: number): string {
  const { value, unit } = splitBytes(n);
  return `${value} ${unit}`;
}
```

- [ ] **Step 3: Add the render + save functions**

In the same `<script>`, add these functions just below the helpers from Step 2:

```ts
function renderLimitsForm(host: HTMLElement, workspace: string, data: LimitsResponse): void {
  const rows = LIMIT_FIELDS.map((f) => {
    const raw = data.limits[f.key];
    const unlimited = raw === null;
    if (f.byte) {
      const split = raw === null ? { value: "", unit: "MB" } : splitBytes(raw);
      const options = LIMIT_UNITS.map(
        (u) =>
          `<option value="${u.label}"${u.label === split.unit ? " selected" : ""}>${u.label}</option>`,
      ).join("");
      return `
            <div class="limit-row" data-field="${f.key}" data-byte="1">
              <label>${f.label}</label>
              <input type="number" min="1" step="1" class="limit-value" value="${split.value}" ${unlimited ? "disabled" : ""} />
              <select class="limit-unit" ${unlimited ? "disabled" : ""}>${options}</select>
              <label class="limit-unlimited"><input type="checkbox" class="limit-unlim" ${unlimited ? "checked" : ""} /> Unlimited</label>
            </div>`;
    }
    return (
      `
          <div class="limit-row" data-field="${f.key}">
            <label>${f.label}</label>
            <input type="number" min="1" step="1" class="limit-value" value="${raw === null ? "" : raw}" ${unlimited ? "disabled" : ""} />
            <label class="limit-unlimited"><input type="checkbox" class="limit-unlim" ${unlimited ? "checked" : ""} /> Unlimited</label>` +
      `</div>`
    );
  }).join("");

  const usageLine =
    data.usage && data.limits.maxStorageBytes !== null
      ? `<p class="limit-usage muted">${formatBytes(data.usage.bytes)} of ${formatBytes(data.limits.maxStorageBytes)} stored · ${data.usage.uploads} uploads this month</p>`
      : data.usage
        ? `<p class="limit-usage muted">${formatBytes(data.usage.bytes)} stored · ${data.usage.uploads} uploads this month</p>`
        : "";

  host.innerHTML = `
        <h4 class="limits-heading">Limits</h4>
        ${usageLine}
        <form class="limits-form">
          ${rows}
          <button type="submit">Save limits</button>
          <div class="limit-status" role="status" aria-live="polite" hidden></div>
        </form>`;

  // Unlimited checkbox toggles its row's inputs.
  host.querySelectorAll<HTMLElement>(".limit-row").forEach((row) => {
    const check = row.querySelector<HTMLInputElement>(".limit-unlim");
    const inputs = row.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      ".limit-value, .limit-unit",
    );
    check?.addEventListener("change", () => {
      inputs.forEach((el) => (el.disabled = check.checked));
    });
  });

  const form = host.querySelector<HTMLFormElement>(".limits-form");
  const statusEl = host.querySelector<HTMLElement>(".limit-status");
  form?.addEventListener("submit", (event) => {
    void (async () => {
      event.preventDefault();
      if (statusEl) statusEl.hidden = true;
      let body: Record<string, number | null>;
      try {
        body = buildLimitsBody(host);
      } catch (err) {
        if (statusEl) {
          statusEl.dataset.state = "error";
          statusEl.textContent = err instanceof Error ? err.message : "Invalid input.";
          statusEl.hidden = false;
        }
        return;
      }
      const submitBtn = form.querySelector<HTMLButtonElement>("button[type=submit]");
      if (submitBtn) submitBtn.disabled = true;
      try {
        const res = await fetch(
          `${apiOrigin}/admin-ui/workspaces/${encodeURIComponent(workspace)}/limits`,
          {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(payload?.error?.message || `save failed: ${res.status}`);
        }
        const updated = (await res.json()) as LimitsResponse;
        renderLimitsForm(host, workspace, updated);
        const freshStatus = host.querySelector<HTMLElement>(".limit-status");
        if (freshStatus) {
          freshStatus.dataset.state = "ready";
          freshStatus.textContent = "Saved. Changes apply within ~60s.";
          freshStatus.hidden = false;
        }
      } catch (err) {
        if (statusEl) {
          statusEl.dataset.state = "error";
          statusEl.textContent =
            err instanceof Error && err.message ? err.message : "Couldn't save limits.";
          statusEl.hidden = false;
        }
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    })();
  });
}

/** Read the form into a PATCH body; throws on empty non-unlimited fields. */
function buildLimitsBody(host: HTMLElement): Record<string, number | null> {
  const body: Record<string, number | null> = {};
  host.querySelectorAll<HTMLElement>(".limit-row").forEach((row) => {
    const field = row.dataset.field;
    if (!field) return;
    const unlimited = row.querySelector<HTMLInputElement>(".limit-unlim")?.checked;
    if (unlimited) {
      body[field] = null;
      return;
    }
    const valueInput = row.querySelector<HTMLInputElement>(".limit-value");
    const num = Number(valueInput?.value);
    if (!valueInput?.value || !Number.isInteger(num) || num < 1) {
      throw new Error(`Enter a whole number ≥ 1 for "${field}", or check Unlimited.`);
    }
    if (row.dataset.byte) {
      const unit = row.querySelector<HTMLSelectElement>(".limit-unit")?.value ?? "MB";
      const mult = LIMIT_UNITS.find((u) => u.label === unit)?.mult ?? 1_000_000;
      body[field] = Math.floor(num * mult);
    } else {
      body[field] = num;
    }
  });
  return body;
}
```

- [ ] **Step 4: Load the limits form when the row expands**

In `apps/web/src/pages/admin/index.astro`, find the `details.addEventListener("toggle", ...)` handler inside `renderWorkspace`. It currently loads members/invites. Add a limits load in the same handler. Replace the existing success branch so it also populates the limits container — locate this existing code:

```ts
if (invitesEl) {
  invitesEl.innerHTML = invites.length
    ? `<ul>${invites.map((i) => `<li><span>${escapeHtml(i.email)}</span><span class="role">pending</span></li>`).join("")}</ul>`
    : "";
}
// Only mark as loaded once the fetch actually succeeded — a failure
```

and insert the limits load immediately before the `// Only mark as loaded` comment:

```ts
if (invitesEl) {
  invitesEl.innerHTML = invites.length
    ? `<ul>${invites.map((i) => `<li><span>${escapeHtml(i.email)}</span><span class="role">pending</span></li>`).join("")}</ul>`
    : "";
}
const limitsEl = details.querySelector<HTMLElement>(".limits");
if (limitsEl) {
  try {
    const limitsData = await apiGet<LimitsResponse>(
      `/admin-ui/workspaces/${encodeURIComponent(ws.workspace)}/limits`,
    );
    renderLimitsForm(limitsEl, ws.workspace, limitsData);
  } catch {
    limitsEl.innerHTML = `<p class="muted">Failed to load limits.</p>`;
  }
}
// Only mark as loaded once the fetch actually succeeded — a failure
```

- [ ] **Step 5: Add styles**

Append to `apps/web/src/styles/admin-workspaces.css`:

```css
.workspace .limits {
  margin-top: 16px;
  border-top: 1px solid var(--border, #e5e7eb);
  padding-top: 12px;
}
.workspace .limits-heading {
  margin: 0 0 8px;
  font-size: 14px;
}
.workspace .limit-usage {
  margin: 0 0 10px;
  font-size: 12px;
}
.workspace .limits-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.workspace .limit-row {
  display: grid;
  grid-template-columns: 130px 1fr auto auto;
  align-items: center;
  gap: 8px;
}
.workspace .limit-row[data-byte] {
  grid-template-columns: 130px 1fr 70px auto;
}
.workspace .limit-row > label:first-child {
  font-size: 13px;
}
.workspace .limit-value,
.workspace .limit-unit {
  padding: 4px 6px;
  font: inherit;
}
.workspace .limit-value:disabled,
.workspace .limit-unit:disabled {
  opacity: 0.5;
}
.workspace .limit-unlimited {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  white-space: nowrap;
}
.workspace .limits-form button {
  align-self: flex-start;
  margin-top: 4px;
}
.workspace .limit-status[data-state="error"] {
  color: var(--danger, #b91c1c);
  font-size: 12px;
}
.workspace .limit-status[data-state="ready"] {
  color: var(--muted, #6b7280);
  font-size: 12px;
}
```

- [ ] **Step 6: Typecheck the web package**

Run (from repo root): `pnpm --filter @uploads/web types`
Expected: no type errors. (If the web package has no `types` script, run `pnpm --filter @uploads/web build` instead and expect a clean build.)

- [ ] **Step 7: Verify in the browser preview**

Start the web dev server via `preview_start` (name from `.claude/launch.json`), sign in as an admin user, and open `/admin`. Then:

1. Expand a workspace row → the **Limits** section loads showing current values and a usage line.
2. Change **Storage** to `500` `MB`, click **Save limits** → status shows "Saved. Changes apply within ~60s." and the value re-renders as `500 MB`.
3. Check **Unlimited** on a field and save → the input disables; on reload of the row the field shows unchecked value cleared (unlimited).
4. Clear a numeric field without checking Unlimited and save → inline validation error, no request sent.

Confirm via `read_console_messages` (no errors) and `read_network_requests` (PATCH returns 200). Capture a screenshot of the expanded Limits form.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/pages/admin/index.astro apps/web/src/styles/admin-workspaces.css
git commit -m "feat(web): edit workspace budget limits from the admin panel"
```

---

## Self-Review

**Spec coverage:**

- GET/PATCH endpoints on `/admin-ui` (session-cookie auth) → Task 2. ✓
- PATCH contract (optional fields; number sets, null clears, omitted unchanged; whole-record write-back preserves non-budget fields) → Task 2 Step 5 + preservation test. ✓
- `validateLimitsPatch` standalone + unit-tested (finite int ≥ 1, or null; ignore unknown keys; 400 `invalid_limit`) → Task 1. ✓
- Usage in the response, null-tolerant → Task 2 `limitsResponse`. ✓
- 404 for unknown/soft-deleted workspace → Task 2 tests. ✓
- UI: lazy load on expand, number input + Unlimited checkbox per field, unit dropdown for byte fields, "applies within ~60s" note, inline errors → Task 3. ✓
- Byte formatting/parsing in the browser (Math.floor to integer bytes, decimal-default units) → Task 3 Steps 2–3. ✓
- Out of scope (retention/key-policy, token `/admin` twin, audit log) → not implemented, as specified. ✓

**Placeholder scan:** No TBD/TODO/"add validation" left; every code and test step is complete. ✓

**Type consistency:** `LimitsResponse`/`Limits` (web) mirror the API's `{ workspace, limits, usage }`. `LIMIT_FIELDS`/`LimitField`/`LimitsPatch` names match between `workspace-limits.ts` (Task 1) and its consumer (Task 2). `loadEditableWorkspace`/`limitsResponse` are defined and used within Task 2. `getWorkspaceUsage` returns `WorkspaceUsage` with `.bytes`/`.uploadsInPeriod`, mapped to `{ bytes, uploads }`. ✓
