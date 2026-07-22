# Billing Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the infrastructure for workspace subscription plans (free/pro) with no live billing — a dedicated `@uploads/billing` package, a `plan` field on `WorkspaceRecord`, admin + user-facing routes, and workspace/admin UI, all defaulting every workspace to `free` today.

**Architecture:** New private package `packages/billing` owns the plan catalog, pure limit-resolution, and a `BillingProvider` interface with a `NullBillingProvider`. `apps/api` wires `plan` into `WorkspaceRecord` and routes limit resolution through `resolvePlanLimits`, then exposes admin (`/admin-ui/workspaces/:name/plan`) and user (`/me/workspaces/:name/billing`) endpoints. `apps/web` adds a workspace `billing.astro` tab and an admin-panel plan selector next to the existing limits form.

**Tech Stack:** TypeScript, Hono (Cloudflare Workers), Astro (vanilla `<script>`, no framework), plain Vitest via the root `vitest.projects.ts` runner, pnpm workspaces, oxfmt formatting, Changesets (this package is excluded, like other private packages).

## Global Constraints

- No Stripe SDK anywhere in this iteration — `packages/billing` only defines the `BillingProvider` interface and a `NullBillingProvider`.
- `packages/billing` is private (`"private": true`), not published, and added to `.changeset/config.json`'s `ignore` list alongside `@uploads/api`, `@uploads/mcp`, `@uploads/web`, `@uploads/storage`, `@uploads/auth`.
- Unknown/legacy plan string found in KV at read time → fail-open to `free`, never lockout.
- Explicit per-workspace admin limit overrides (the existing four `LIMIT_FIELDS`: `maxStorageBytes`, `maxUploadsPerPeriod`, `maxUploadBytes`, `maxVideoUploadBytes`) always beat plan defaults.
- `free` plan defaults = current self-serve defaults from `apps/api/src/self-serve-defaults.ts`'s `SELF_SERVE_LIMITS` (`maxStorageBytes: 250_000_000`, `maxUploadsPerPeriod: 3000`, `maxUploadBytes: 25_000_000`, `maxVideoUploadBytes: 8_000_000`).
- `pro` plan is defined with `available: false` — display metadata only, no live upgrade path. Admins may still set a workspace's plan to `pro` (operator override) even though it's unavailable to self-serve users.
- `plan?: 'free' | 'pro'` on `WorkspaceRecord` is optional; absent means `free`. No migration or backfill script.
- No D1 subscription table, no webhook route, no Worker secrets in this iteration.
- Repo test command: `pnpm test` (root Vitest runner via `vitest.projects.ts`, auto-discovers `packages/*`/`apps/*` — no manual registration needed for a new package).
- Format with `oxfmt` (repo convention — see AGENTS.md), not Prettier.
- Unauthorized plan changes never happen from `apps/web`: the admin PATCH route stays session+`requireAdminUser`-gated exactly like the existing limits routes; the user-facing `GET /me/workspaces/:name/billing` route is read-only.

---

## File Structure

- **Create** `packages/billing/package.json`, `packages/billing/tsconfig.json`, `packages/billing/README.md` — package scaffold mirroring `packages/storage`'s conventions (private, `type: module`, `exports` map, `typecheck`/`test` scripts).
- **Create** `packages/billing/src/plans.ts` — the plan catalog (`PlanId`, `PlanDefinition`, `PLANS`, `getPlan`).
- **Create** `packages/billing/src/resolve.ts` — `resolvePlanLimits(plan, overrides)`, pure precedence logic.
- **Create** `packages/billing/src/provider.ts` — `BillingProvider` interface + `NullBillingProvider`.
- **Create** `packages/billing/src/index.ts` — barrel export.
- **Create** `packages/billing/test/plans.test.ts`, `packages/billing/test/resolve.test.ts`, `packages/billing/test/provider.test.ts`.
- **Modify** `apps/api/package.json` — add `"@uploads/billing": "workspace:^"` dependency and a `"./billing"`-style export is not needed (apps/api imports the package directly, not re-exported).
- **Modify** `apps/api/src/workspace.ts` — add `plan?: 'free' | 'pro'` field + doc comment to `WorkspaceRecord`.
- **Modify** `apps/api/src/budget.ts` — route `resolveBudgetLimits` through `resolvePlanLimits` so plan defaults backstop the four budget fields when a workspace has no explicit override.
- **Modify** `apps/api/src/self-serve-defaults.ts` — no functional change needed (already matches `free` plan defaults), but add a comment cross-referencing `@uploads/billing`'s catalog as the source of truth going forward.
- **Create** `apps/api/src/workspace-plan.ts` — `validatePlanPatch` (mirrors `workspace-limits.ts`'s `validateLimitsPatch` pattern) + `planResponse` helper shared by admin GET/PATCH.
- **Modify** `apps/api/src/routes/admin-ui.ts` — add `GET /workspaces/:name/plan` and `PATCH /workspaces/:name/plan`.
- **Modify** `apps/api/src/routes/admin-ui.test.ts` — tests for the two new routes.
- **Create** `apps/api/src/workspace-plan.test.ts` — unit tests for `validatePlanPatch`.
- **Modify** `apps/api/src/budget.test.ts` (or create if absent — checked in Task 4) — regression tests proving existing override behavior unchanged and plan-default fallback works.
- **Modify** `apps/api/src/routes/me.ts` — add `GET /workspaces/:name/billing`.
- **Modify** `apps/api/src/routes/me.test.ts` — tests for the new route.
- **Create** `apps/web/src/pages/account/workspaces/[name]/billing.astro` — workspace billing tab.
- **Modify** `apps/web/src/lib/workspaces-nav.ts` — register `billing` in `WorkspaceNavTab`, `WORKSPACE_NAV_TABS`, and `workspaceTabFromPathname`.
- **Modify** `apps/web/src/layouts/WorkspaceLayout.astro` — no change required (tab links are rail-independent; nav lives in `workspaces-nav.ts`'s sidebar switcher, not the layout). Verified in Task 7 — skip if confirmed unnecessary.
- **Modify** `apps/web/src/pages/admin/index.astro` — add a plan selector to `renderWorkspace`'s expanded `<details>` view, next to the limits form.
- **Modify** `.changeset/config.json` — add `@uploads/billing` to `ignore`.

---

## Task 1: `packages/billing` scaffold + plan catalog

**Files:**

- Create: `packages/billing/package.json`
- Create: `packages/billing/tsconfig.json`
- Create: `packages/billing/README.md`
- Create: `packages/billing/src/plans.ts`
- Create: `packages/billing/src/index.ts`
- Test: `packages/billing/test/plans.test.ts`

**Interfaces:**

- Produces: `PlanId = "free" | "pro"`; `WorkspacePlanLimits` (renamed local shape matching `WorkspaceBudgetLimits`'s four fields: `maxStorageBytes?`, `maxUploadsPerPeriod?`, `maxUploadBytes?`, `maxVideoUploadBytes?`); `PlanDefinition { id: PlanId; name: string; blurb: string; available: boolean; defaultLimits: WorkspacePlanLimits }`; `PLANS: Record<PlanId, PlanDefinition>`; `getPlan(id: string): PlanDefinition` (fails open to `PLANS.free` for any unrecognized string — this is the single fail-open chokepoint every other task relies on).

- [ ] **Step 1: Create the package scaffold**

Create `packages/billing/package.json`:

```json
{
  "name": "@uploads/billing",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^6.0.3",
    "vitest": "^4.1.10"
  }
}
```

Create `packages/billing/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

Create `packages/billing/README.md`:

```markdown
# @uploads/billing

Plan catalog, limit-resolution, and the billing-provider seam for workspace
subscription plans. Every workspace is on the `free` plan today; `pro` is
defined but unavailable (`available: false`) — no Stripe SDK, checkout, or
subscription persistence yet. See
`docs/superpowers/specs/2026-07-22-billing-infrastructure-design.md`.

Private workspace package — not published, excluded from Changesets like
`@uploads/api` / `@uploads/storage` / `@uploads/web` / `@uploads/auth`.
```

- [ ] **Step 2: Write the failing catalog test**

Create `packages/billing/test/plans.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { getPlan, PLANS } from "../src/plans";

describe("PLANS catalog", () => {
  it("defines free as available with the current self-serve defaults", () => {
    expect(PLANS.free.available).toBe(true);
    expect(PLANS.free.defaultLimits).toEqual({
      maxStorageBytes: 250_000_000,
      maxUploadsPerPeriod: 3000,
      maxUploadBytes: 25_000_000,
      maxVideoUploadBytes: 8_000_000,
    });
  });

  it("defines pro as unavailable display metadata", () => {
    expect(PLANS.pro.available).toBe(false);
    expect(PLANS.pro.id).toBe("pro");
    expect(typeof PLANS.pro.name).toBe("string");
    expect(PLANS.pro.name.length).toBeGreaterThan(0);
  });

  it("every plan's id matches its catalog key", () => {
    for (const [key, plan] of Object.entries(PLANS)) {
      expect(plan.id).toBe(key);
    }
  });
});

describe("getPlan", () => {
  it("returns the matching catalog entry for a known id", () => {
    expect(getPlan("pro")).toBe(PLANS.pro);
  });

  it("fails open to free for an unknown or legacy plan string", () => {
    expect(getPlan("enterprise")).toBe(PLANS.free);
    expect(getPlan("")).toBe(PLANS.free);
    expect(getPlan(undefined)).toBe(PLANS.free);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/billing && pnpm install && pnpm test`
Expected: FAIL — `Cannot find module '../src/plans'` (module doesn't exist yet). If `pnpm install` at the repo root hasn't linked the new workspace package yet, run `pnpm install` from the repo root first.

- [ ] **Step 4: Implement the plan catalog**

Create `packages/billing/src/plans.ts`:

```typescript
/**
 * Plan catalog for workspace subscription plans (free-plan era, spec
 * 2026-07-22). `free` is available in perpetuity today; `pro` is defined for
 * display purposes only (`available: false`) — no checkout path exists yet.
 * `defaultLimits.free` mirrors `apps/api/src/self-serve-defaults.ts`'s
 * `SELF_SERVE_LIMITS`; keep the two in sync if either changes.
 */

export type PlanId = "free" | "pro";

/** The four budget-limit fields a plan can default — same shape as
 * `apps/api/src/budget.ts`'s `WorkspaceBudgetLimits` plus the two
 * per-upload caps from `WorkspaceRecord`, kept here as an independent type
 * so this package has no dependency on `@uploads/api`. */
export interface WorkspacePlanLimits {
  maxStorageBytes?: number;
  maxUploadsPerPeriod?: number;
  maxUploadBytes?: number;
  maxVideoUploadBytes?: number;
}

export interface PlanDefinition {
  id: PlanId;
  /** Display name shown in the workspace billing tab and admin panel. */
  name: string;
  /** One-sentence description of the plan. */
  blurb: string;
  /** Whether a workspace/user can actually be on this plan today. */
  available: boolean;
  defaultLimits: WorkspacePlanLimits;
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  free: {
    id: "free",
    name: "Free",
    blurb: "Everything you need to host screenshots and files for your projects.",
    available: true,
    defaultLimits: {
      maxStorageBytes: 250_000_000,
      maxUploadsPerPeriod: 3000,
      maxUploadBytes: 25_000_000,
      maxVideoUploadBytes: 8_000_000,
    },
  },
  pro: {
    id: "pro",
    name: "Pro",
    blurb: "Higher storage and upload limits for teams — coming soon.",
    available: false,
    defaultLimits: {
      maxStorageBytes: 25_000_000_000,
      maxUploadsPerPeriod: 100_000,
      maxUploadBytes: 100_000_000,
      maxVideoUploadBytes: 50_000_000,
    },
  },
};

/** All valid plan ids, in catalog order. */
export const PLAN_IDS = Object.keys(PLANS) as PlanId[];

function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && value in PLANS;
}

/**
 * The catalog entry for `id`. Fails open to `PLANS.free` for any
 * unrecognized or missing value — legacy/unknown plan strings found in KV
 * must never lock a workspace out, per the spec's error-handling section.
 */
export function getPlan(id: unknown): PlanDefinition {
  return isPlanId(id) ? PLANS[id] : PLANS.free;
}
```

Create `packages/billing/src/index.ts`:

```typescript
export * from "./plans";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/billing && pnpm test`
Expected: PASS — all `plans.test.ts` assertions green.

- [ ] **Step 6: Commit**

```bash
git add packages/billing/package.json packages/billing/tsconfig.json packages/billing/README.md packages/billing/src/plans.ts packages/billing/src/index.ts packages/billing/test/plans.test.ts
git commit -m "feat(billing): scaffold @uploads/billing with the plan catalog"
```

---

## Task 2: `resolvePlanLimits` — precedence resolution

**Files:**

- Create: `packages/billing/src/resolve.ts`
- Modify: `packages/billing/src/index.ts`
- Test: `packages/billing/test/resolve.test.ts`

**Interfaces:**

- Consumes: `PlanId`, `WorkspacePlanLimits`, `getPlan` (from Task 1's `plans.ts`).
- Produces: `resolvePlanLimits(plan: PlanId | undefined, overrides: WorkspacePlanLimits): Required<WorkspacePlanLimits>` is NOT the right shape (fields can be legitimately unlimited/absent) — actual signature: `resolvePlanLimits(plan: PlanId | string | undefined, overrides: WorkspacePlanLimits): WorkspacePlanLimits`. Per-field precedence: an explicit (defined) override field wins; otherwise fall back to the plan's `defaultLimits` field; otherwise the field is `undefined` (unlimited). Consumed by `apps/api/src/budget.ts` (Task 4) with `plan` sourced from `WorkspaceRecord.plan` and `overrides` sourced from the existing four `WorkspaceRecord` fields.

- [ ] **Step 1: Write the failing precedence test**

Create `packages/billing/test/resolve.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { resolvePlanLimits } from "../src/resolve";
import { PLANS } from "../src/plans";

describe("resolvePlanLimits", () => {
  it("uses the plan's default limits when there are no overrides", () => {
    expect(resolvePlanLimits("free", {})).toEqual(PLANS.free.defaultLimits);
  });

  it("an explicit override beats the plan default for that field", () => {
    const resolved = resolvePlanLimits("free", { maxStorageBytes: 1_000 });
    expect(resolved.maxStorageBytes).toBe(1_000);
    expect(resolved.maxUploadsPerPeriod).toBe(PLANS.free.defaultLimits.maxUploadsPerPeriod);
  });

  it("an override of undefined does not shadow the plan default", () => {
    const resolved = resolvePlanLimits("free", { maxStorageBytes: undefined });
    expect(resolved.maxStorageBytes).toBe(PLANS.free.defaultLimits.maxStorageBytes);
  });

  it("resolves pro's own (unavailable) defaults when a workspace is set to pro", () => {
    expect(resolvePlanLimits("pro", {})).toEqual(PLANS.pro.defaultLimits);
  });

  it("fails open to free's defaults for an unknown plan string", () => {
    expect(resolvePlanLimits("enterprise", {})).toEqual(PLANS.free.defaultLimits);
  });

  it("fails open to free's defaults when plan is undefined (absent-in-KV case)", () => {
    expect(resolvePlanLimits(undefined, {})).toEqual(PLANS.free.defaultLimits);
  });

  it("all four override fields compose independently", () => {
    const resolved = resolvePlanLimits("free", {
      maxStorageBytes: 1,
      maxUploadsPerPeriod: 2,
      maxUploadBytes: 3,
      maxVideoUploadBytes: 4,
    });
    expect(resolved).toEqual({
      maxStorageBytes: 1,
      maxUploadsPerPeriod: 2,
      maxUploadBytes: 3,
      maxVideoUploadBytes: 4,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/billing && pnpm test`
Expected: FAIL — `Cannot find module '../src/resolve'`.

- [ ] **Step 3: Implement `resolvePlanLimits`**

Create `packages/billing/src/resolve.ts`:

```typescript
/**
 * Precedence resolution between a workspace's plan defaults and its
 * explicit per-workspace overrides (the admin-editable budget fields on
 * `WorkspaceRecord` — see PR #280 / `apps/api/src/workspace-limits.ts`).
 * Pure — no I/O — so `apps/api/src/budget.ts` and the admin/user routes can
 * all call through this single chokepoint without drifting on precedence.
 */
import { getPlan, type PlanId, type WorkspacePlanLimits } from "./plans";

const LIMIT_KEYS: (keyof WorkspacePlanLimits)[] = [
  "maxStorageBytes",
  "maxUploadsPerPeriod",
  "maxUploadBytes",
  "maxVideoUploadBytes",
];

/**
 * Resolves effective limits for a workspace: an explicit (defined) override
 * field always wins; otherwise falls back to the resolved plan's
 * `defaultLimits` for that field. `plan` fails open to `free` via `getPlan`
 * for any unrecognized/missing value, so a legacy or malformed plan string
 * never locks a workspace out.
 */
export function resolvePlanLimits(
  plan: PlanId | string | undefined,
  overrides: WorkspacePlanLimits,
): WorkspacePlanLimits {
  const defaults = getPlan(plan).defaultLimits;
  const resolved: WorkspacePlanLimits = {};
  for (const key of LIMIT_KEYS) {
    const override = overrides[key];
    resolved[key] = override !== undefined ? override : defaults[key];
  }
  return resolved;
}
```

- [ ] **Step 4: Export it from the barrel**

In `packages/billing/src/index.ts`, add:

```typescript
export * from "./resolve";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/billing && pnpm test`
Expected: PASS — all `resolve.test.ts` and `plans.test.ts` assertions green.

- [ ] **Step 6: Commit**

```bash
git add packages/billing/src/resolve.ts packages/billing/src/index.ts packages/billing/test/resolve.test.ts
git commit -m "feat(billing): add resolvePlanLimits precedence resolution"
```

---

## Task 3: `BillingProvider` / `NullBillingProvider`

**Files:**

- Create: `packages/billing/src/provider.ts`
- Modify: `packages/billing/src/index.ts`
- Test: `packages/billing/test/provider.test.ts`

**Interfaces:**

- Consumes: `PlanId` (from `plans.ts`).
- Produces: `Subscription | null` shape; `BillingProvider` interface with `getSubscription(workspace: string): Promise<Subscription | null>`, `createCheckoutSession(workspace: string, plan: PlanId): Promise<never>`, `createPortalSession(workspace: string): Promise<never>`; `NullBillingProvider` class implementing it. Consumed by Task 6's `GET /me/workspaces/:name/billing` route (`subscription` field in the response, `null` today).

- [ ] **Step 1: Write the failing provider test**

Create `packages/billing/test/provider.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { NullBillingProvider } from "../src/provider";

describe("NullBillingProvider", () => {
  it("getSubscription always resolves null (no subscription today)", async () => {
    const provider = new NullBillingProvider();
    await expect(provider.getSubscription("acme")).resolves.toBeNull();
  });

  it("createCheckoutSession rejects — no checkout path exists yet", async () => {
    const provider = new NullBillingProvider();
    await expect(provider.createCheckoutSession("acme", "pro")).rejects.toThrow(
      /not available|unavailable/i,
    );
  });

  it("createPortalSession rejects — no billing portal exists yet", async () => {
    const provider = new NullBillingProvider();
    await expect(provider.createPortalSession("acme")).rejects.toThrow(
      /not available|unavailable/i,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/billing && pnpm test`
Expected: FAIL — `Cannot find module '../src/provider'`.

- [ ] **Step 3: Implement the provider interface + null implementation**

Create `packages/billing/src/provider.ts`:

```typescript
/**
 * Billing-provider seam (spec 2026-07-22's "future iteration" section). No
 * live billing exists yet — `NullBillingProvider` is the only implementation
 * today, always reporting "free, no subscription". A future
 * `StripeBillingProvider` implements the same interface inside this
 * package; no Stripe SDK dependency exists anywhere yet.
 */
import type { PlanId } from "./plans";

/** A workspace's live subscription state, as reported by the provider. */
export interface Subscription {
  plan: PlanId;
  status: "active" | "canceled" | "past_due";
  /** ISO timestamp of the current billing period's end, if known. */
  currentPeriodEnd?: string;
}

export interface BillingProvider {
  /** The workspace's current subscription, or `null` if it has none
   * (e.g. it's on the free plan with nothing to bill). */
  getSubscription(workspace: string): Promise<Subscription | null>;
  /** Starts a checkout flow for upgrading `workspace` to `plan`. Rejects
   * until a real provider is wired up. */
  createCheckoutSession(workspace: string, plan: PlanId): Promise<never>;
  /** Starts a customer-portal session for `workspace`. Rejects until a
   * real provider is wired up. */
  createPortalSession(workspace: string): Promise<never>;
}

/**
 * The only `BillingProvider` implementation today. Every workspace reports
 * no subscription; checkout/portal are unavailable. Honest placeholder —
 * apps/web's billing tab renders a disabled "Upgrade — coming soon"
 * affordance rather than calling these.
 */
export class NullBillingProvider implements BillingProvider {
  async getSubscription(_workspace: string): Promise<Subscription | null> {
    return null;
  }

  async createCheckoutSession(_workspace: string, _plan: PlanId): Promise<never> {
    throw new Error("checkout is not available yet");
  }

  async createPortalSession(_workspace: string): Promise<never> {
    throw new Error("the billing portal is not available yet");
  }
}
```

- [ ] **Step 4: Export it from the barrel**

In `packages/billing/src/index.ts`, add:

```typescript
export * from "./provider";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/billing && pnpm test`
Expected: PASS — all three `packages/billing/test/*.test.ts` files green.

- [ ] **Step 6: Commit**

```bash
git add packages/billing/src/provider.ts packages/billing/src/index.ts packages/billing/test/provider.test.ts
git commit -m "feat(billing): add BillingProvider interface and NullBillingProvider"
```

---

## Task 4: `plan` field on `WorkspaceRecord` + budget-resolution wiring

**Files:**

- Modify: `apps/api/package.json`
- Modify: `apps/api/src/workspace.ts` (add `plan` field near the other optional record fields, e.g. after `retentionDays` around line 66)
- Modify: `apps/api/src/budget.ts`
- Test: `apps/api/src/budget.test.ts` (create if it doesn't already exist — check with `ls apps/api/src/budget.test.ts` first; if present, add to it)

**Interfaces:**

- Consumes: `resolvePlanLimits`, `WorkspacePlanLimits` from `@uploads/billing` (Task 2).
- Produces: `WorkspaceRecord.plan?: 'free' | 'pro'`; `resolveBudgetLimits(record: WorkspaceBudgetLimits & { plan?: string }): { maxStorageBytes?: number; maxUploadsPerPeriod?: number }` — same call sites as before (`checkPutBudget`, `usageWithLimits`) now plan-aware. Consumed by Task 5's admin plan routes and Task 6's user billing route, both of which read `record.plan` and call `resolvePlanLimits`.

- [ ] **Step 1: Add the `@uploads/billing` dependency**

In `apps/api/package.json`, add to `"dependencies"` (alphabetical, before `"@uploads/email"`):

```json
    "@uploads/billing": "workspace:^",
```

Run: `pnpm install` (repo root) to link the new workspace dependency.

- [ ] **Step 2: Write the failing regression test for plan-aware budget resolution**

Check whether `apps/api/src/budget.test.ts` exists:

Run: `ls apps/api/src/budget.test.ts`

If it exists, add the following `describe` block to the end of the file; if it does not exist, create it with this content plus the necessary imports (`resolveBudgetLimits` from `./budget`):

```typescript
import { describe, expect, it } from "vitest";
import { resolveBudgetLimits } from "./budget";

describe("resolveBudgetLimits — plan-aware resolution", () => {
  it("falls back to the free plan's defaults when a workspace has no explicit limits and no plan set", () => {
    expect(resolveBudgetLimits({})).toEqual({
      maxStorageBytes: 250_000_000,
      maxUploadsPerPeriod: 3000,
    });
  });

  it("an explicit maxStorageBytes override still beats the plan default (existing PR #280 behavior)", () => {
    expect(resolveBudgetLimits({ maxStorageBytes: 500 })).toEqual({
      maxStorageBytes: 500,
      maxUploadsPerPeriod: 3000,
    });
  });

  it("a workspace explicitly on the pro plan resolves pro's defaults", () => {
    expect(resolveBudgetLimits({ plan: "pro" })).toEqual({
      maxStorageBytes: 25_000_000_000,
      maxUploadsPerPeriod: 100_000,
    });
  });

  it("an unknown/legacy plan string fails open to free's defaults", () => {
    expect(resolveBudgetLimits({ plan: "enterprise" })).toEqual({
      maxStorageBytes: 250_000_000,
      maxUploadsPerPeriod: 3000,
    });
  });

  it("a zero/negative/non-finite override is treated as unset, falling back to the plan default (unchanged positiveLimit behavior)", () => {
    expect(resolveBudgetLimits({ maxStorageBytes: 0 })).toEqual({
      maxStorageBytes: 250_000_000,
      maxUploadsPerPeriod: 3000,
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/api && pnpm test -- budget.test.ts`
Expected: FAIL — `resolveBudgetLimits({})` currently returns `{ maxStorageBytes: undefined, maxUploadsPerPeriod: undefined }`, not the free-plan defaults.

- [ ] **Step 4: Add the `plan` field to `WorkspaceRecord`**

In `apps/api/src/workspace.ts`, after the `retentionDays` field (around line 66, before `autoPrefixBareKeys`), add:

```typescript
  /**
   * Subscription plan (spec 2026-07-22, billing infrastructure). Absent
   * means `free`. Admin-only to change today (no self-serve upgrade path
   * exists); an unrecognized string is treated as `free` at read time by
   * `@uploads/billing`'s `getPlan` — never a lockout.
   */
  plan?: "free" | "pro";
```

- [ ] **Step 5: Route `resolveBudgetLimits` through `resolvePlanLimits`**

In `apps/api/src/budget.ts`, update the imports and `WorkspaceBudgetLimits`/`resolveBudgetLimits`:

```typescript
import { InsufficientStorageError, RateLimitedError } from "@uploads/errors";
import { resolvePlanLimits } from "@uploads/billing";
import type { WorkspaceUsage } from "./usage";

/** Cumulative caps from the workspace registry record. */
export interface WorkspaceBudgetLimits {
  /** Hard cap on net stored bytes. */
  maxStorageBytes?: number;
  /** Cap on successful puts in the current UTC calendar month. */
  maxUploadsPerPeriod?: number;
  /** Subscription plan — see `@uploads/billing`'s `PlanId`. Absent = free. */
  plan?: string;
}
```

Replace the body of `resolveBudgetLimits`:

```typescript
export function resolveBudgetLimits(record: WorkspaceBudgetLimits): {
  maxStorageBytes?: number;
  maxUploadsPerPeriod?: number;
} {
  const explicit = {
    maxStorageBytes: positiveLimit(record.maxStorageBytes),
    maxUploadsPerPeriod: positiveLimit(record.maxUploadsPerPeriod),
  };
  const resolved = resolvePlanLimits(record.plan, explicit);
  return {
    maxStorageBytes: positiveLimit(resolved.maxStorageBytes),
    maxUploadsPerPeriod: positiveLimit(resolved.maxUploadsPerPeriod),
  };
}
```

Note: `positiveLimit` is applied both before calling `resolvePlanLimits` (so a `0`/negative/non-finite explicit value is treated as "unset" and falls through to the plan default, preserving existing behavior) and after (in case a future plan's own `defaultLimits` were ever malformed — defense in depth, costs nothing since today's catalog values are always valid positive integers).

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/api && pnpm test -- budget.test.ts`
Expected: PASS — all `resolveBudgetLimits` assertions green, including the pre-existing tests in the file (if it already existed) still passing unchanged.

- [ ] **Step 7: Run the full existing budget/usage/limits suite to check for regressions**

Run: `pnpm test -- budget usage workspace-limits admin-ui` (root runner, name-filtered)
Expected: PASS — no existing test broke. In particular `apps/api/src/routes/admin-ui.test.ts`'s `workspace limits editing` describe block (which exercises `limitsResponse`, not `resolveBudgetLimits`) is unaffected since that function reads raw record fields directly, not through budget resolution.

- [ ] **Step 8: Commit**

```bash
git add apps/api/package.json apps/api/src/workspace.ts apps/api/src/budget.ts apps/api/src/budget.test.ts pnpm-lock.yaml
git commit -m "feat(billing): add plan field to WorkspaceRecord, wire budget resolution through resolvePlanLimits"
```

---

## Task 5: Admin plan routes (`GET`/`PATCH /admin-ui/workspaces/:name/plan`)

**Files:**

- Create: `apps/api/src/workspace-plan.ts`
- Test: `apps/api/src/workspace-plan.test.ts`
- Modify: `apps/api/src/routes/admin-ui.ts`
- Modify: `apps/api/src/routes/admin-ui.test.ts`

**Interfaces:**

- Consumes: `PLAN_IDS`, `getPlan`, `resolvePlanLimits`, `PlanId` from `@uploads/billing`; `loadEditableWorkspace`, `WorkspaceRecord` from `../workspace` and this file's own module scope in `admin-ui.ts`.
- Produces: `validatePlanPatch(body: unknown): { plan: PlanId }` (throws `ValidationError` with `code: "invalid_plan"` on bad input); `planResponse(name: string, record: WorkspaceRecord): { workspace: string; plan: PlanId; available: boolean; limits: WorkspacePlanLimits; overrides: string[] }` where `overrides` lists which of the four limit field names are explicit per-workspace overrides (i.e. defined on the record) rather than plan defaults. Consumed by Task 8's admin-panel plan selector, which calls these two routes.

- [ ] **Step 1: Write the failing test for `validatePlanPatch`**

Create `apps/api/src/workspace-plan.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { planResponse, validatePlanPatch } from "./workspace-plan";

describe("validatePlanPatch", () => {
  it("accepts a known plan id", () => {
    expect(validatePlanPatch({ plan: "pro" })).toEqual({ plan: "pro" });
    expect(validatePlanPatch({ plan: "free" })).toEqual({ plan: "free" });
  });

  it("rejects an unknown plan id", () => {
    expect(() => validatePlanPatch({ plan: "enterprise" })).toThrow(/invalid_plan|plan/i);
  });

  it("rejects a missing plan field", () => {
    expect(() => validatePlanPatch({})).toThrow(/invalid_plan|plan/i);
  });

  it("rejects a non-object body", () => {
    expect(() => validatePlanPatch(null)).toThrow(/invalid_plan|plan/i);
    expect(() => validatePlanPatch("pro")).toThrow(/invalid_plan|plan/i);
  });
});

describe("planResponse", () => {
  it("reports the free plan, its resolved limits, and no overrides for a bare record", () => {
    const result = planResponse("acme", { provider: "r2", bucket: "b" });
    expect(result).toEqual({
      workspace: "acme",
      plan: "free",
      available: true,
      limits: {
        maxStorageBytes: 250_000_000,
        maxUploadsPerPeriod: 3000,
        maxUploadBytes: 25_000_000,
        maxVideoUploadBytes: 8_000_000,
      },
      overrides: [],
    });
  });

  it("lists explicit override fields and resolves them into limits", () => {
    const result = planResponse("acme", {
      provider: "r2",
      bucket: "b",
      maxStorageBytes: 999,
    });
    expect(result.overrides).toEqual(["maxStorageBytes"]);
    expect(result.limits.maxStorageBytes).toBe(999);
    expect(result.limits.maxUploadsPerPeriod).toBe(3000);
  });

  it("reports pro as unavailable when a workspace is set to it", () => {
    const result = planResponse("acme", { provider: "r2", bucket: "b", plan: "pro" });
    expect(result.plan).toBe("pro");
    expect(result.available).toBe(false);
  });

  it("fails open to free for an unrecognized stored plan string", () => {
    const result = planResponse("acme", {
      provider: "r2",
      bucket: "b",
      plan: "enterprise" as never,
    });
    expect(result.plan).toBe("free");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm test -- workspace-plan.test.ts`
Expected: FAIL — `Cannot find module './workspace-plan'`.

- [ ] **Step 3: Implement `workspace-plan.ts`**

Create `apps/api/src/workspace-plan.ts`:

```typescript
/**
 * Validates the plan-change body accepted by the admin panel's
 * PATCH /admin-ui/workspaces/:name/plan endpoint, and builds the response
 * shared by that route's GET/PATCH — mirrors workspace-limits.ts's
 * validateLimitsPatch / admin-ui.ts's limitsResponse pattern (spec
 * 2026-07-22, billing infrastructure).
 */
import { getPlan, PLAN_IDS, resolvePlanLimits, type PlanId } from "@uploads/billing";
import { ValidationError } from "@uploads/errors";
import type { WorkspaceRecord } from "./workspace";

const LIMIT_FIELDS_FOR_OVERRIDES = [
  "maxStorageBytes",
  "maxUploadsPerPeriod",
  "maxUploadBytes",
  "maxVideoUploadBytes",
] as const;

export function validatePlanPatch(body: unknown): { plan: PlanId } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("plan body must be a JSON object", { code: "invalid_plan" });
  }
  const record = body as Record<string, unknown>;
  const plan = record.plan;
  if (typeof plan !== "string" || !PLAN_IDS.includes(plan as PlanId)) {
    throw new ValidationError(`plan must be one of: ${PLAN_IDS.join(", ")}`, {
      code: "invalid_plan",
    });
  }
  return { plan: plan as PlanId };
}

/** Response body shared by GET and PATCH /admin-ui/workspaces/:name/plan. */
export function planResponse(name: string, record: WorkspaceRecord) {
  const definition = getPlan(record.plan);
  const overrides = LIMIT_FIELDS_FOR_OVERRIDES.filter((field) => record[field] !== undefined);
  const limits = resolvePlanLimits(record.plan, {
    maxStorageBytes: record.maxStorageBytes,
    maxUploadsPerPeriod: record.maxUploadsPerPeriod,
    maxUploadBytes: record.maxUploadBytes,
    maxVideoUploadBytes: record.maxVideoUploadBytes,
  });
  return {
    workspace: name,
    plan: definition.id,
    available: definition.available,
    limits,
    overrides,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && pnpm test -- workspace-plan.test.ts`
Expected: PASS — all `validatePlanPatch`/`planResponse` assertions green.

- [ ] **Step 5: Write failing route tests in `admin-ui.test.ts`**

Add the following `describe` block to `apps/api/src/routes/admin-ui.test.ts`, right after the existing `describe("workspace limits editing", ...)` block (it reuses that block's `limitsEnv` helper and `REC` fixture — both already in module scope by the time this block runs since they're declared with `const`/`function` inside the outer describe; if `limitsEnv`/`REC` are scoped inside that `describe` block rather than the test file's top level, hoist them to file scope first so this new block can use them, or duplicate the minimal fixture inline as shown):

```typescript
describe("workspace plan editing", () => {
  const REC = {
    provider: "r2",
    bucket: "uploads-default",
    prefix: "acme/",
  };

  function planEnv(user: typeof ADMIN_USER | null, record: Record<string, unknown> | null) {
    const store = new Map<string, string>();
    if (record) store.set("ws:acme", JSON.stringify(record));
    const base = stubEnv(user, () => new Response(null, { status: 404 }));
    const env = {
      ...base,
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

  it("GET returns the free plan and resolved defaults for a bare record", async () => {
    const { env } = planEnv(ADMIN_USER, REC);
    const res = await app().request("/admin-ui/workspaces/acme/plan", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspace: "acme",
      plan: "free",
      available: true,
      limits: {
        maxStorageBytes: 250_000_000,
        maxUploadsPerPeriod: 3000,
        maxUploadBytes: 25_000_000,
        maxVideoUploadBytes: 8_000_000,
      },
      overrides: [],
    });
  });

  it("PATCH sets the plan on the record and persists it", async () => {
    const { env, store } = planEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/plan",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan: "pro" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: string; available: boolean };
    expect(body.plan).toBe("pro");
    expect(body.available).toBe(false);
    expect(JSON.parse(store.get("ws:acme") ?? "{}").plan).toBe("pro");
  });

  it("PATCH rejects an unknown plan id", async () => {
    const { env } = planEnv(ADMIN_USER, REC);
    const res = await app().request(
      "/admin-ui/workspaces/acme/plan",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan: "enterprise" }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("PATCH preserves existing limit overrides on the record", async () => {
    const { env, store } = planEnv(ADMIN_USER, { ...REC, maxStorageBytes: 999 });
    await app().request(
      "/admin-ui/workspaces/acme/plan",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan: "pro" }),
      },
      env,
    );
    const stored = JSON.parse(store.get("ws:acme") ?? "{}");
    expect(stored.maxStorageBytes).toBe(999);
    expect(stored.plan).toBe("pro");
  });

  it("GET 404s for an unknown workspace", async () => {
    const { env } = planEnv(ADMIN_USER, null);
    const res = await app().request("/admin-ui/workspaces/acme/plan", {}, env);
    expect(res.status).toBe(404);
  });

  it("403s for a non-admin session", async () => {
    const { env } = planEnv(NON_ADMIN_USER, REC);
    const res = await app().request("/admin-ui/workspaces/acme/plan", {}, env);
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd apps/api && pnpm test -- admin-ui.test.ts`
Expected: FAIL — `404` for both new routes (no `/plan` route registered yet).

- [ ] **Step 7: Add the routes to `admin-ui.ts`**

In `apps/api/src/routes/admin-ui.ts`, add the import (alongside the existing `workspace-limits` import):

```typescript
import { planResponse, validatePlanPatch } from "../workspace-plan";
```

Add the two routes immediately after the existing `.patch("/workspaces/:name/limits", ...)` block (after line 491, before the `.get("/workspaces/:name/settings", ...)` block):

```typescript
  // Read the workspace's plan, its availability, and resolved effective
  // limits (plan defaults backstopped by any explicit overrides).
  .get("/workspaces/:name/plan", async (c) => {
    const name = c.req.param("name");
    const record = await loadEditableWorkspace(c.env, name);
    return c.json(planResponse(name, record));
  })

  // Set the workspace's plan. Admins may set `pro` even though it's
  // unavailable to self-serve users (operator override) — availability is
  // informational in the response, not enforced here. Limit overrides on
  // the record are untouched; only `plan` is written.
  .patch("/workspaces/:name/plan", async (c) => {
    const name = c.req.param("name");
    if (!(await allowWrite(c.env, name))) {
      throw new RateLimitedError("rate limit exceeded");
    }
    const record = await loadEditableWorkspace(c.env, name);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ValidationError("request body must be valid JSON", { code: "invalid_plan" });
    }
    const { plan } = validatePlanPatch(body);
    record.plan = plan;
    await c.env.REGISTRY.put(`ws:${name}`, JSON.stringify(record));
    return c.json(planResponse(name, record));
  })
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd apps/api && pnpm test -- admin-ui.test.ts`
Expected: PASS — all new `workspace plan editing` assertions green, and every pre-existing `admin-ui.test.ts` test still green.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/workspace-plan.ts apps/api/src/workspace-plan.test.ts apps/api/src/routes/admin-ui.ts apps/api/src/routes/admin-ui.test.ts
git commit -m "feat(billing): add admin GET/PATCH /admin-ui/workspaces/:name/plan routes"
```

---

## Task 6: User-facing `GET /me/workspaces/:name/billing`

**Files:**

- Modify: `apps/api/src/routes/me.ts`
- Modify: `apps/api/src/routes/me.test.ts`

**Interfaces:**

- Consumes: `getPlan`, `resolvePlanLimits`, `NullBillingProvider` from `@uploads/billing`; `memberWorkspaceOr404`, `requireUserId`, `loadWorkspaceRecord` (all already in `me.ts`); `usageWithLimits`, `getWorkspaceUsage` (already imported in `me.ts`).
- Produces: response shape `{ workspace: string; organization: {...}; plan: string; available: boolean; limits: WorkspacePlanLimits; usage: {...} | null; subscription: null }` — stable across the future Stripe iteration per the spec (adding real subscription data later only changes `subscription` from `null` to a populated object).

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/routes/me.test.ts` (find the existing pattern for a member-gated `GET /workspaces/:name/...` test — e.g. the `usage` or `summary` route tests — and follow the same env/fixture setup used there). Add this `describe` block:

```typescript
describe("GET /me/workspaces/:name/billing", () => {
  it("returns plan, resolved limits, usage, and a null subscription for a member", async () => {
    const env = memberEnv(SESSION_USER, "acme", "member", {
      provider: "r2",
      bucket: "b",
    });
    const res = await app().request("/me/workspaces/acme/billing", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspace: string;
      plan: string;
      available: boolean;
      limits: Record<string, number>;
      subscription: null;
    };
    expect(body.workspace).toBe("acme");
    expect(body.plan).toBe("free");
    expect(body.available).toBe(true);
    expect(body.limits.maxStorageBytes).toBe(250_000_000);
    expect(body.subscription).toBeNull();
  });

  it("404s for a non-member", async () => {
    const env = memberEnv(SESSION_USER, "acme", null, { provider: "r2", bucket: "b" });
    const res = await app().request("/me/workspaces/acme/billing", {}, env);
    expect(res.status).toBe(404);
  });

  it("reports pro plan and its own resolved limits when the workspace is on pro", async () => {
    const env = memberEnv(SESSION_USER, "acme", "member", {
      provider: "r2",
      bucket: "b",
      plan: "pro",
    });
    const res = await app().request("/me/workspaces/acme/billing", {}, env);
    const body = (await res.json()) as { plan: string; available: boolean };
    expect(body.plan).toBe("pro");
    expect(body.available).toBe(false);
  });
});
```

Note: `memberEnv`/`SESSION_USER` (or whatever the file's existing member-gated test helper and fixture user are actually named) must be read from the top of `apps/api/src/routes/me.test.ts` before writing this block — inspect the file's existing `describe("GET /workspaces/:name/usage", ...)` or `describe("GET /workspaces/:name/summary", ...)` tests and reuse their exact helper names and env-construction shape (including how membership + `REGISTRY`/`DB` fakes are wired), since `me.ts`'s auth path (`memberWorkspaceOr404` via `membershipsForUser`) differs from `admin-ui.ts`'s and this plan's fixture names are illustrative, not verbatim guaranteed to exist.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && pnpm test -- me.test.ts`
Expected: FAIL — `404` (route not found) or similar, since `/workspaces/:name/billing` doesn't exist yet.

- [ ] **Step 3: Add the route to `me.ts`**

In `apps/api/src/routes/me.ts`, add the import (alongside the existing `../budget`/`../workspace` imports):

```typescript
import { getPlan, NullBillingProvider, resolvePlanLimits } from "@uploads/billing";
```

Add a module-scope provider instance near the top of the file (after imports, before `EMAIL_RE`):

```typescript
// No live billing yet — see @uploads/billing's NullBillingProvider doc
// comment. Swapping in a real provider later only changes this line.
const billingProvider = new NullBillingProvider();
```

Add the route after the existing `.get("/workspaces/:name/summary", ...)` block (after line 230):

```typescript
  // Plan metadata, resolved effective limits, usage, and subscription state
  // (always null today) for the account billing tab — 404s unless the
  // caller is a member. Response shape is stable across the future Stripe
  // iteration: adding a real subscription only changes `subscription` from
  // null to a populated object.
  .get("/workspaces/:name/billing", async (c) => {
    const name = c.req.param("name");
    const ws = await memberWorkspaceOr404(c.env, requireUserId(c), name);

    const record = await loadWorkspaceRecord(c.env, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const definition = getPlan(record.plan);
    const limits = resolvePlanLimits(record.plan, {
      maxStorageBytes: record.maxStorageBytes,
      maxUploadsPerPeriod: record.maxUploadsPerPeriod,
      maxUploadBytes: record.maxUploadBytes,
      maxVideoUploadBytes: record.maxVideoUploadBytes,
    });

    let usage: ReturnType<typeof usageWithLimits> | null = null;
    try {
      usage = usageWithLimits(await getWorkspaceUsage(c.env.DB, name), record);
    } catch {
      usage = null;
    }

    const subscription = await billingProvider.getSubscription(name);

    return c.json({
      workspace: ws.workspace,
      organization: ws.organization,
      plan: definition.id,
      available: definition.available,
      limits,
      usage,
      subscription,
    });
  })
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && pnpm test -- me.test.ts`
Expected: PASS — all new `GET /me/workspaces/:name/billing` assertions green, all pre-existing `me.test.ts` tests still green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/me.ts apps/api/src/routes/me.test.ts
git commit -m "feat(billing): add GET /me/workspaces/:name/billing"
```

---

## Task 7: `billing.astro` workspace tab + nav registration

**Files:**

- Create: `apps/web/src/pages/account/workspaces/[name]/billing.astro`
- Modify: `apps/web/src/lib/workspaces-nav.ts`
- Modify: `apps/web/src/lib/api-client.ts` (add `getWorkspaceBilling`)

**Interfaces:**

- Consumes: `WorkspaceLayout` (props: `{ workspace: string }`), `isBrowseWorkspace` (from `../../../../lib/workspace-browse-url`), `getPageVisit`/`isCurrentPageVisit`/`onAstroPageLoad`/`onSession`/`requireElement` (from `../../../../lib/account-shell`), `resolveActiveWorkspace` (from `../../../../lib/workspace-browse-url`), `escapeHtml` (from `../../../../lib/workspace-ui`). New: `GET /me/workspaces/:name/billing` (Task 6).
- Produces: `WorkspaceNavTab` gains `"billing"`; `WORKSPACE_NAV_TABS` gains `{ id: "billing", label: "billing", path: "/billing" }`; `workspaceTabFromPathname` recognizes the `/billing` segment; `getWorkspaceBilling(apiOrigin, workspace)` in `api-client.ts` returning a discriminated result consumed by the new page.

- [ ] **Step 1: Inspect `api-client.ts`'s existing result-shape pattern**

Run: `grep -n "getWorkspacePeople\|getWorkspaceUsage\|type.*Result" apps/web/src/lib/api-client.ts | head -30`

Read the matched `getWorkspacePeople` (or equivalent `getWorkspaceUsage`/`getWorkspaceSummary`) function in full — including its return type's `kind: "ok" | "unavailable"` discriminant and how a 404 is mapped to `reason: "not_found"` versus a network/5xx failure — before writing Step 2, so the new function matches the file's exact conventions (fetch options, `credentials: "include"`, error mapping) rather than inventing a new shape.

- [ ] **Step 2: Add `getWorkspaceBilling` to `api-client.ts`**

Add near the other `getWorkspace*` read functions (e.g. next to `getWorkspaceUsage`/`getWorkspaceSummary`), following the exact fetch/error-handling pattern found in Step 1 (illustrative shape below — match the file's real helper, e.g. a shared `apiGet`/`fetchJson` wrapper, if one exists rather than duplicating raw `fetch` calls):

```typescript
export interface WorkspaceBilling {
  workspace: string;
  organization: { id: string; slug: string; name: string };
  plan: string;
  available: boolean;
  limits: {
    maxStorageBytes?: number;
    maxUploadsPerPeriod?: number;
    maxUploadBytes?: number;
    maxVideoUploadBytes?: number;
  };
  usage: Record<string, unknown> | null;
  subscription: null;
}

export type WorkspaceBillingResult =
  | { kind: "ok"; billing: WorkspaceBilling }
  | { kind: "unavailable"; reason: "not_found" | "network" };

export async function getWorkspaceBilling(
  apiOrigin: string,
  workspace: string,
): Promise<WorkspaceBillingResult> {
  try {
    const res = await fetch(`${apiOrigin}/me/workspaces/${encodeURIComponent(workspace)}/billing`, {
      credentials: "include",
      cache: "no-store",
    });
    if (res.status === 404) return { kind: "unavailable", reason: "not_found" };
    if (!res.ok) return { kind: "unavailable", reason: "network" };
    return { kind: "ok", billing: (await res.json()) as WorkspaceBilling };
  } catch {
    return { kind: "unavailable", reason: "network" };
  }
}
```

- [ ] **Step 3: Register the `billing` tab in `workspaces-nav.ts`**

In `apps/web/src/lib/workspaces-nav.ts`, change:

```typescript
export type WorkspaceNavTab = "files" | "galleries" | "people" | "settings";
```

to:

```typescript
export type WorkspaceNavTab = "files" | "galleries" | "people" | "billing" | "settings";
```

Update `WORKSPACE_NAV_TABS` to insert `billing` before `settings`:

```typescript
export const WORKSPACE_NAV_TABS: {
  id: WorkspaceNavTab;
  label: string;
  /** Path suffix after `/account/workspaces/:name` — empty for files. */
  path: string;
}[] = [
  { id: "files", label: "files", path: "" },
  { id: "galleries", label: "galleries", path: "/galleries" },
  { id: "people", label: "people", path: "/people" },
  { id: "billing", label: "billing", path: "/billing" },
  { id: "settings", label: "settings", path: "/settings" },
];
```

Update `workspaceTabFromPathname` to recognize the new segment:

```typescript
export function workspaceTabFromPathname(pathname: string): WorkspaceNavTab | "" {
  const match = pathname.match(/^\/account\/workspaces\/([^/]+)(?:\/([^/]+))?\/?$/);
  if (!match) return "";
  const slug = decodeURIComponent(match[1] ?? "");
  if (!slug || slug === "new") return "";
  const segment = match[2] ?? "";
  if (!segment) return "files";
  if (segment === "galleries") return "galleries";
  if (segment === "people" || segment === "invite") return "people";
  if (segment === "billing") return "billing";
  if (segment === "settings") return "settings";
  return "";
}
```

- [ ] **Step 4: Create `billing.astro`**

Create `apps/web/src/pages/account/workspaces/[name]/billing.astro`, following `people.astro`'s structure exactly (loading/error states via `#ws-status`/`#ws-retry`/`#ws-app`, `getPageVisit`/`isCurrentPageVisit` staleness guard, `onSession`-driven initial load):

```astro
---
/**
 * Workspace billing tab — current plan, resolved limits vs usage, and a
 * disabled "Upgrade — coming soon" affordance (spec 2026-07-22, billing
 * infrastructure). No live billing exists yet: no invoices, no payment
 * method, no real upgrade flow — honest copy only.
 */
import WorkspaceLayout from "../../../../layouts/WorkspaceLayout.astro";
import { isBrowseWorkspace } from "../../../../lib/workspace-browse-url";

export const prerender = false;

const nameParam = Astro.params.name ?? "";
const workspace = isBrowseWorkspace(nameParam) ? nameParam : "";
if (!workspace) return Astro.redirect("/account/workspaces");
---

<WorkspaceLayout workspace={workspace}>
  <div id="ws-status" class="ul-callout status" role="status">Loading…</div>
  <button id="ws-retry" type="button" hidden>Try again</button>

  <div id="ws-app" hidden>
    <section class="card settings-page">
      <div class="settings-section">
        <div class="ws-page-header">
          <div class="ws-title-block">
            <h2>Billing</h2>
            <p class="muted" id="ws-slug"></p>
          </div>
          <a class="text-btn" id="ws-back" href={`/account/workspaces/${workspace}`}>← Workspace</a>
        </div>

        <div id="ws-plan-card" class="ul-callout">
          <p><strong id="ws-plan-name"></strong></p>
          <p class="muted" id="ws-plan-blurb"></p>
        </div>

        <div id="ws-limits" class="settings-section">
          <h3>Limits &amp; usage</h3>
          <dl class="ws-rail__kv" id="ws-limits-list"></dl>
        </div>

        <div class="settings-section">
          <button type="button" id="ws-upgrade-btn" disabled>Upgrade — coming soon</button>
        </div>
      </div>
    </section>
  </div>

  <script>
    import {
      getPageVisit,
      isCurrentPageVisit,
      onAstroPageLoad,
      onSession,
      requireElement,
    } from "../../../../lib/account-shell";
    import { getWorkspaceBilling, type WorkspaceBilling } from "../../../../lib/api-client";
    import { resolveActiveWorkspace } from "../../../../lib/workspace-browse-url";

    onAstroPageLoad(() => {
      if (!document.getElementById("ws-plan-card")) return;

      const page = "workspace billing";
      const visit = getPageVisit();
      const stillHere = (): boolean => isCurrentPageVisit(visit);
      const w = window as unknown as {
        __UPLOADS_API_ORIGIN__: string;
        __UPLOADS_ACTIVE_WORKSPACE__: string;
      };
      const apiOrigin = w.__UPLOADS_API_ORIGIN__;
      const workspaceName = resolveActiveWorkspace(
        window.location.pathname,
        w.__UPLOADS_ACTIVE_WORKSPACE__ || "",
      );

      const statusEl = requireElement<HTMLElement>("#ws-status", page);
      const retryBtn = requireElement<HTMLButtonElement>("#ws-retry", page);
      const appEl = requireElement<HTMLElement>("#ws-app", page);
      const slugEl = requireElement<HTMLElement>("#ws-slug", page);
      const planNameEl = requireElement<HTMLElement>("#ws-plan-name", page);
      const planBlurbEl = requireElement<HTMLElement>("#ws-plan-blurb", page);
      const limitsListEl = requireElement<HTMLElement>("#ws-limits-list", page);

      function showError(message: string, retry = true): void {
        if (!stillHere()) return;
        statusEl.hidden = false;
        statusEl.textContent = message;
        statusEl.dataset.state = "error";
        appEl.hidden = true;
        retryBtn.hidden = !retry;
      }

      function formatBytes(n: number): string {
        if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)} GB`;
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)} MB`;
        return `${n} bytes`;
      }

      function paintLimits(billing: WorkspaceBilling): void {
        const usage = billing.usage as
          | { bytes?: number; objects?: number; uploadsInPeriod?: number }
          | null;
        const rows: string[] = [];
        if (billing.limits.maxStorageBytes !== undefined) {
          const used = usage?.bytes ?? 0;
          rows.push(
            `<dt>Storage</dt><dd>${formatBytes(used)} of ${formatBytes(billing.limits.maxStorageBytes)}</dd>`,
          );
        }
        if (billing.limits.maxUploadsPerPeriod !== undefined) {
          const used = usage?.uploadsInPeriod ?? 0;
          rows.push(
            `<dt>Uploads this month</dt><dd>${used} of ${billing.limits.maxUploadsPerPeriod}</dd>`,
          );
        }
        if (billing.limits.maxUploadBytes !== undefined) {
          rows.push(`<dt>Max file size</dt><dd>${formatBytes(billing.limits.maxUploadBytes)}</dd>`);
        }
        if (billing.limits.maxVideoUploadBytes !== undefined) {
          rows.push(
            `<dt>Max video size</dt><dd>${formatBytes(billing.limits.maxVideoUploadBytes)}</dd>`,
          );
        }
        limitsListEl.innerHTML = rows.join("");
      }

      async function loadBillingPage(): Promise<void> {
        if (!stillHere()) return;
        statusEl.hidden = false;
        statusEl.textContent = "Loading…";
        statusEl.removeAttribute("data-state");
        retryBtn.hidden = true;
        appEl.hidden = true;

        const result = await getWorkspaceBilling(apiOrigin, workspaceName);
        if (!stillHere()) return;
        if (result.kind === "unavailable") {
          if (result.reason === "not_found") {
            showError("You don’t have access to this workspace.", false);
            return;
          }
          showError("Billing is temporarily unavailable. Check the local stack or try again.");
          return;
        }

        const { billing } = result;
        planNameEl.textContent = `${billing.plan === "pro" ? "Pro" : "Free"} plan`;
        planBlurbEl.textContent = billing.available
          ? "This plan is active on your workspace."
          : "This plan isn’t available for self-serve upgrade yet.";
        paintLimits(billing);

        statusEl.hidden = true;
        appEl.hidden = false;

        const displayName = billing.organization.name || workspaceName;
        slugEl.textContent =
          displayName === workspaceName ? workspaceName : `${displayName} · ${workspaceName}`;
        document.title = `Billing · ${displayName} · uploads.sh`;
      }

      retryBtn.addEventListener("click", () => {
        void loadBillingPage();
      });

      onSession(() => {
        void loadBillingPage();
      });
    });
  </script>
</WorkspaceLayout>
```

- [ ] **Step 5: Manually verify the page renders**

Run the local dev stack per `AGENTS.md` (`pnpm dev` or the project's documented local-auth-verify recipe — see the `uploads-web-local-auth-verify` memory: portless stack at `https://uploads.localhost`). Navigate to `/account/workspaces/<a-workspace-you-belong-to>/billing` and confirm:

- The page loads without a console error.
- Plan name, blurb, and limits render.
- The "Upgrade — coming soon" button is present and disabled.
- The sidebar switcher shows a `billing` link between `people` and `settings` and it's marked current (`aria-current="page"`) on this route.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/account/workspaces/\[name\]/billing.astro apps/web/src/lib/workspaces-nav.ts apps/web/src/lib/api-client.ts
git commit -m "feat(billing): add workspace billing tab"
```

---

## Task 8: Admin panel plan selector

**Files:**

- Modify: `apps/web/src/pages/admin/index.astro`

**Interfaces:**

- Consumes: `apiGet<T>` (existing helper in the file), `escapeHtml` (existing helper), `GET`/`PATCH /admin-ui/workspaces/:name/plan` (Task 5).
- Produces: `renderPlanSelector(host: HTMLElement, workspace: string, data: PlanResponse): void`, wired into `renderWorkspace`'s `<details>` toggle handler exactly like `limits`/`github-links`, with its own `planLoaded` flag.

- [ ] **Step 1: Add a `<div class="plan">` slot to the workspace detail markup**

In `apps/web/src/pages/admin/index.astro`'s `renderWorkspace` function, insert a new div immediately before `<div class="limits" ...>` (around line 278):

```html
<div class="plan" data-state="unloaded"></div>
<div class="limits" data-state="unloaded"></div>
```

- [ ] **Step 2: Add the `PlanResponse` interface and `renderPlanSelector` function**

Add near the `interface LimitsResponse` block (after it, around line 72):

```typescript
interface PlanResponse {
  workspace: string;
  plan: "free" | "pro";
  available: boolean;
  limits: Limits;
  overrides: string[];
}

const PLAN_OPTIONS: { id: "free" | "pro"; label: string }[] = [
  { id: "free", label: "Free" },
  { id: "pro", label: "Pro (unavailable to self-serve)" },
];

function renderPlanSelector(host: HTMLElement, workspace: string, data: PlanResponse): void {
  const options = PLAN_OPTIONS.map(
    (opt) =>
      `<option value="${opt.id}"${opt.id === data.plan ? " selected" : ""}>${escapeHtml(opt.label)}</option>`,
  ).join("");

  host.innerHTML = `
        <h4 class="plan-heading">Plan</h4>
        <p class="muted plan-availability">${data.available ? "Available" : "Not available for self-serve upgrade"}</p>
        <form class="plan-form">
          <select class="plan-select">${options}</select>
          <button type="submit">Save plan</button>
          <div class="plan-status" role="status" aria-live="polite" hidden></div>
        </form>`;

  const form = host.querySelector<HTMLFormElement>(".plan-form");
  const statusEl = host.querySelector<HTMLElement>(".plan-status");
  form?.addEventListener("submit", (event) => {
    void (async () => {
      event.preventDefault();
      if (statusEl) statusEl.hidden = true;
      const select = host.querySelector<HTMLElement>(
        ".plan-select",
      ) as unknown as HTMLSelectElement | null;
      const plan = select?.value ?? "free";
      const submitBtn = form.querySelector<HTMLButtonElement>("button[type=submit]");
      if (submitBtn) submitBtn.disabled = true;
      try {
        const res = await fetch(
          `${apiOrigin}/admin-ui/workspaces/${encodeURIComponent(workspace)}/plan`,
          {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ plan }),
          },
        );
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(payload?.error?.message || `save failed: ${res.status}`);
        }
        const updated = (await res.json()) as PlanResponse;
        renderPlanSelector(host, workspace, updated);
        const freshStatus = host.querySelector<HTMLElement>(".plan-status");
        if (freshStatus) {
          freshStatus.dataset.state = "ready";
          freshStatus.textContent = "Saved.";
          freshStatus.hidden = false;
        }
      } catch (err) {
        if (statusEl) {
          statusEl.dataset.state = "error";
          statusEl.textContent =
            err instanceof Error && err.message ? err.message : "Couldn't save plan.";
          statusEl.hidden = false;
        }
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    })();
  });
}
```

- [ ] **Step 3: Wire the load into the `<details>` toggle handler**

In `renderWorkspace`, alongside the existing `let limitsLoaded = false;` (around line 305), add:

```typescript
let planLoaded = false;
```

Add a new independent-load block alongside the existing limits block (after the limits `void (async () => { ... })();` block, around line 360, before the GitHub-links block):

```typescript
// Plan selector — independent load, own retry flag, same pattern as
// limits above.
void (async () => {
  if (!details.open || planLoaded) return;
  const planEl = details.querySelector<HTMLElement>(".plan");
  if (!planEl) return;
  try {
    const planData = await apiGet<PlanResponse>(
      `/admin-ui/workspaces/${encodeURIComponent(ws.workspace)}/plan`,
    );
    renderPlanSelector(planEl, ws.workspace, planData);
    planLoaded = true;
  } catch {
    planEl.innerHTML = `<p class="muted">Failed to load plan.</p>`;
  }
})();
```

- [ ] **Step 4: Manually verify in the browser**

Run the local dev stack, sign in as an admin user, open `/admin`, expand a workspace, and confirm:

- A "Plan" section renders with a `<select>` showing Free/Pro and the correct current selection.
- Changing the selection and clicking "Save plan" persists (reload the page / re-expand and see it stuck).
- Selecting "Pro (unavailable to self-serve)" saves successfully (admin override allowed) and the "Not available for self-serve upgrade" note appears.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/admin/index.astro
git commit -m "feat(billing): add plan selector to the admin workspace panel"
```

---

## Task 9: Changeset ignore entry

**Files:**

- Modify: `.changeset/config.json`

**Interfaces:**

- None — configuration-only change.

No public docs page is added by this feature (the spec's Web section only touches the account/admin surfaces, not `/docs`), so `apps/web/public/sitemap.xml` and `apps/web/src/pages/llms.txt` (or equivalent) need no update — confirmed N/A per the spec.

- [ ] **Step 1: Add `@uploads/billing` to the ignore list**

In `.changeset/config.json`, change:

```json
  "ignore": ["@uploads/api", "@uploads/mcp", "@uploads/web", "@uploads/storage", "@uploads/auth"]
```

to:

```json
  "ignore": ["@uploads/api", "@uploads/mcp", "@uploads/web", "@uploads/storage", "@uploads/auth", "@uploads/billing"]
```

- [ ] **Step 2: Verify no changeset accidentally targets the new package**

Run: `ls .changeset/*.md 2>/dev/null`
Expected: any pre-existing changeset files (if present, from unrelated in-flight work) do not reference `@uploads/billing` — confirm with `grep -l billing .changeset/*.md 2>/dev/null` returning nothing. This guards against the "changeset targeting an ignored package silently blocks every npm publish" trap recorded from prior work on this repo.

- [ ] **Step 3: Commit**

```bash
git add .changeset/config.json
git commit -m "chore(billing): exclude @uploads/billing from changeset releases"
```

---

## Task 10: Full-suite verification

**Files:** none (verification-only task).

- [ ] **Step 1: Run the full root test suite**

Run: `pnpm test`
Expected: PASS — every project under `apps/*`/`packages/*` (including the new `packages/billing`) passes with no regressions.

- [ ] **Step 2: Typecheck the touched packages**

Run: `cd packages/billing && pnpm typecheck && cd ../../apps/api && pnpm typecheck && cd ../web && pnpm run astro check 2>/dev/null || pnpm run build`

(Use whichever typecheck/build command `apps/web`'s `package.json` actually defines — inspect `apps/web/package.json`'s `"scripts"` first if `astro check` isn't present.)

Expected: PASS — no type errors introduced by the `plan` field, `@uploads/billing` imports, or the new Astro page.

- [ ] **Step 3: Format check**

Run: `pnpm oxfmt --check` (or the repo's documented format-check script — confirm the exact command in `package.json`'s root `"scripts"` or `AGENTS.md` before running)

Expected: PASS, or run the writer (non `--check`) variant and commit any formatting fixes as a final `chore: oxfmt` commit if needed.

- [ ] **Step 4: Final commit (if formatting changed anything)**

```bash
git add -A
git commit -m "chore(billing): oxfmt"
```

---

## Self-Review Notes

**Spec coverage:**

- Package contents (`plans.ts`, `resolve.ts`, `provider.ts`) → Tasks 1–3.
- `plan?: 'free' | 'pro'` on `WorkspaceRecord`, absent ⇒ free → Task 4, Step 4.
- `budget.ts`/`self-serve-defaults.ts` routed through `resolvePlanLimits` → Task 4, Step 5 (`self-serve-defaults.ts` itself needs no functional change since its literal values already equal the `free` plan's `defaultLimits` — a doc-comment cross-reference was judged sufficient over a functional rewrite, since `selfServeWorkspaceRecord` intentionally stamps explicit values onto new records rather than relying on plan-default fallback, and rewriting that call site to omit the fields and rely on resolution would be a behavior change beyond this spec's scope).
- Admin `GET`/`PATCH /admin-ui/workspaces/:name/plan` → Task 5.
- User `GET /me/workspaces/:name/billing` → Task 6.
- Workspace `billing.astro` tab + nav registration → Task 7.
- Admin panel plan selector → Task 8.
- Unknown plan PATCH → validation error via `@uploads/errors` → Task 5 (`validatePlanPatch` throws `ValidationError`).
- Unknown/legacy plan string at read time → fail-open to free → Task 1 (`getPlan`) and Task 2/4 (`resolvePlanLimits`/`resolveBudgetLimits` tests explicitly cover this).
- Testing: catalog invariants, resolution precedence, `NullBillingProvider` contract → Tasks 1–3. Admin-ui route tests → Task 5. Budget regression tests → Task 4. Plain vitest via root runner → confirmed throughout (no per-package config added).
- Future iteration section is explicitly documentation-only in the spec — no task implements Stripe, webhooks, or a D1 subscription table, and Global Constraints reiterates this.
- Changeset ignore entry → Task 9. Docs sitemap/llms.txt → explicitly confirmed N/A in Task 9 (no public docs page added).

**Placeholder scan:** No "TBD"/"TODO"/"implement later" strings. Every code step shows complete, real code. Two steps (Task 6 Step 1, Task 7 Step 1) explicitly instruct the implementer to first read an existing file to confirm exact helper names before writing test/production code that depends on them — this is a deliberate "verify against the real file" instruction, not a content placeholder, since the exact fixture/helper names in `me.test.ts` and the exact `api-client.ts` fetch-wrapper pattern were not fully visible during plan authoring and guessing them risks a type/name mismatch; the illustrative code given is complete and correct against the conventions observed in `admin-ui.test.ts`/`people.astro`, and only needs a name-alignment pass if the real file differs.

**Type consistency:** `PlanId`, `WorkspacePlanLimits`, `getPlan`, `resolvePlanLimits`, `PLAN_IDS`, `BillingProvider`, `NullBillingProvider` are defined once in Tasks 1–3 and imported with identical names/signatures in Tasks 4–8. `WorkspaceRecord.plan?: 'free' | 'pro'` (Task 4) matches `PlanId` (Task 1). `planResponse`/`validatePlanPatch` (Task 5) are defined once and consumed identically by the admin routes (Task 5) and referenced by name (not redefined) in Task 8's `PlanResponse` TypeScript interface, which is a separately-declared client-side mirror (Astro page, no shared import across the API/web boundary) — this mirrors the existing `Limits`/`LimitsResponse` pattern already in `admin-index.astro`, so the duplication is consistent with repo convention, not a drift bug.
