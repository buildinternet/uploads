# Subscription billing infrastructure (free-plan era)

Date: 2026-07-22
Status: approved

## Goal

Lay the infrastructure for workspace subscription plans without any live billing.
Every workspace is on a `free` plan in perpetuity today; a paid plan is a defined
but unavailable placeholder. Billing logic is isolated in a dedicated package so
a future Stripe integration stays contained and the open-source repo never holds
secrets (secrets remain Cloudflare Worker secrets, as with existing GitHub keys).

Explicitly out of scope this iteration: Stripe SDK, checkout, webhooks, customer
portal, D1 subscription table, per-user Stripe customers, plan-change emails.

## Architecture

New private workspace package `@uploads/billing` (`packages/billing`), consumed
by `apps/api` (budget resolution, routes) and `apps/web` (display metadata).
Not published; excluded from release versioning like other private packages.

### Package contents

- `plans.ts` — plan catalog:
  - `free`: available, in perpetuity; default limits = current self-serve
    defaults (see `apps/api/src/self-serve-defaults.ts`, e.g. 250 MB storage).
  - `pro`: defined with `available: false`; display metadata only.
  - Each plan: id, display name, blurb, `available`, default
    `WorkspaceBudgetLimits`.
- `resolve.ts` — `resolvePlanLimits(plan, overrides)`: pure. Explicit
  per-workspace admin overrides (PR #280 limit fields) always beat plan
  defaults. Existing workspaces with custom limits are unaffected.
- `provider.ts` — `BillingProvider` interface (`getSubscription`,
  `createCheckoutSession`, `createPortalSession`) with typed results and a
  `NullBillingProvider` returning "free, no subscription". A future
  `StripeBillingProvider` implements the same interface inside this package.
  No Stripe SDK dependency anywhere yet.

## Data model

- `plan?: 'free' | 'pro'` added to the KV `WorkspaceRecord`
  (`apps/api/src/workspace.ts`). Absent ⇒ `free`; no migration or backfill.
- **Enforcement vs display (decided during implementation):** budget
  *enforcement* applies plan defaults only when `record.plan` is explicitly
  set. Records without `plan` keep today's enforcement byte-for-byte (explicit
  limit fields only; absent field = unlimited) — legacy/admin workspaces are
  unlimited today and this iteration must not change production enforcement.
  Self-serve workspaces already carry explicit limit fields, so they are
  unaffected too. *Display* (billing page, admin panel) still resolves absent
  `plan` as `free`.
- `apps/api/src/budget.ts` routes limit resolution through `resolvePlanLimits`
  when a plan is set; `resolvePlanLimits` accepts `number | null | undefined`
  overrides (`null` = explicitly cleared to unlimited, matching
  `workspace-limits.ts` semantics).
- No subscription persistence yet; plan state is the KV field.

## API (apps/api)

- Admin (session-gated, `requireAdminUser`, mirrors limits routes in
  `routes/admin-ui.ts`):
  - `GET /admin-ui/workspaces/:name/plan` — plan, effective limits, which
    values are overrides.
  - `PATCH /admin-ui/workspaces/:name/plan` — set plan (validated against
    catalog; setting `pro` allowed for admins even while unavailable to users).
- User-facing (org-member-gated):
  - `GET /me/workspaces/:name/billing` — plan metadata, effective limits,
    current usage, `subscription` from the provider (`null` today). Response
    shape is stable across the future Stripe iteration.

## Web (apps/web)

- New workspace tab `pages/account/workspaces/[name]/billing.astro`, registered
  in the workspace rail/nav (`workspaces-nav.ts`, `WorkspaceLayout.astro`),
  following the `people.astro` pattern. Content: current plan card, effective
  limits vs usage, disabled "Upgrade — coming soon" affordance. Honest copy —
  no fake invoices or mock billing history.
- Admin panel (`pages/admin/index.astro`): plan selector in the expanded
  workspace view next to the existing limits form, wired to the plan routes.

## Error handling

- Unknown plan value in a PATCH → validation error via `@uploads/errors`.
- Unknown/legacy plan string found in KV at read time → treated as `free`
  (fail-open to the free tier, never lockout).

## Testing

- `packages/billing`: catalog invariants, resolution precedence
  (override > plan default), NullBillingProvider contract.
- `apps/api`: plan route tests alongside `admin-ui.test.ts`; budget resolution
  regression tests proving existing override behavior unchanged.
- Plain vitest via the root runner, per repo convention.

## Future iteration (documented, not built)

Stripe arrives entirely inside `packages/billing` plus: one webhook route in
`apps/api`, `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` Worker secrets, a D1
subscription table, and flipping `pro.available`. Prior art: the releases repo's
dormant `@better-auth/stripe` seam (secret-gated plugin, `plans: []`).
