# Free-plan member cap (issue #450)

Free workspaces include at most **3 members total** (owner + 2). Pro stays
seatless, with a high unmarketed abuse guard. Enforced at invite creation
only — never retroactively.

## Scope rule: which workspaces the cap binds to

`plan` is only ever written by Stripe (`/internal/billing/plan`) or an
operator (`PATCH /admin-ui/workspaces/:name/plan`). Self-serve provisioning
writes free's _numeric_ limits but no `plan` field, and
`resolveEffectiveLimits` treats an absent `plan` as legacy/unlimited. A cap
keyed strictly on `plan === "free"` would therefore bind to almost nobody.

The cap applies when:

- `plan === "free"`, **or**
- `plan` is absent **and** the record is `selfServe`.

It does not apply to legacy operator-provisioned workspaces (no `plan`, not
self-serve) — consistent with the existing "absent plan = legacy/unlimited"
rule — nor to the communal `default` workspace, which is already exempt from
the other member flows.

Precedence, in order: an explicit `maxMembers` override on the record wins
(a number sets the cap, `null` means unlimited); otherwise the resolved
plan's default applies; otherwise unlimited.

## Plan catalog

| Plan | `maxMembers` | Marketed                                        |
| ---- | ------------ | ----------------------------------------------- |
| free | 3            | yes — "3 members" on the plan card              |
| pro  | 25           | no — abuse guard, card says "Unlimited members" |

25 is the same species of number as `maxUploadsPerPeriod`: an unmarketed
ceiling that preserves the seatless positioning and reserves seats/roles for
a future Team tier.

`maxMembers` joins the canonical `LIMIT_FIELDS` list, so admin PATCH
validation, per-workspace overrides, and `planResponse` pick it up without
new plumbing.

Self-serve provisioning deliberately does **not** stamp `maxMembers` onto
new records. Stamping it would create an explicit override that outlives an
upgrade to Pro, since an explicit override beats a plan default.

## Enforcement

Members live in the auth worker's D1; the plan lives in apps/api's KV. The
count must happen where the members are, the cap where the plan is.

Two invite-creation paths exist, and both must be covered:

1. `POST /internal/invite` on apps/auth — what all three apps/api invite
   routes (`/me`, workspace-governance-token, `/admin-ui`) call.
2. `POST /api/auth/organization/invite-member` — Better Auth's own endpoint,
   publicly reachable with a session cookie. Left unguarded it is a direct
   bypass of exactly the quota-pooling abuse this cap closes.

So enforcement lives in **apps/auth**, in one helper used by both:

- `apps/auth/src/member-cap.ts` — `assertMemberCapAvailable(env, db, { org, inviterIsGlobalAdmin })`.
  - Global admins bypass entirely (operators comp via the `maxMembers`
    override; they should not be blocked mid-task).
  - Fetches the resolved cap from apps/api over the existing `API` service
    binding: `GET /internal/billing/member-cap?workspace=<slug>`.
  - Counts current members + **pending** invites for the org. Pending invites
    count, or the cap is fiction.
  - Denies when `members + pendingInvites >= cap`.
- Wired into `POST /internal/invite`, _after_ its idempotent
  existing-pending-invite early return, so re-inviting an already-pending
  email never fails.
- Wired into `organizationHooks.beforeCreateInvitation`, which throws a
  Better Auth `APIError` (403) to block the public endpoint.

**Fail-open** when the `API` binding is absent or answers non-ok — matching
`billing-bridge.ts`'s treatment of the same binding. An apps/api outage must
not break invites.

## Cap lookup route

`GET /internal/billing/member-cap?workspace=<name>` on apps/api, behind the
same `x-internal-billing-key` shared secret as `/internal/billing/plan` (the
timing-safe guard is extracted into a shared helper rather than duplicated).

Returns `{ workspace, cap }`, where `cap` is a number or `null` (unlimited).
`default` and unknown/non-serving workspaces resolve to `null`.

## Error surface

The auth worker returns `403 member_cap_reached`. The apps/api invite routes
map it to a `ForbiddenError` carrying the honest nudge:

> Free workspaces include 3 members — upgrade to Pro for more.

The cap number in the message comes from the resolved cap, not a literal, so
a comped override reads correctly.

## Out of scope

- Seat-based pricing; roles beyond what exists today.
- Any retroactive removal, ejection, or lockout. A workspace over cap (from a
  downgrade, or an operator lowering an override) keeps every member and only
  loses the ability to create new invites. Accepting an already-pending
  invite is never blocked.

## Testing

- `packages/billing`: `resolveMemberCap` precedence and scope-rule table
  (free/pro/absent-plan self-serve/absent-plan legacy/`null` override).
- `apps/auth`: member-cap helper against the in-process fake D1 — under cap,
  at cap, pending invites counted, global-admin bypass, fail-open when the
  binding is missing; plus `POST /internal/invite` returning 403 at cap and
  still returning the existing invite idempotently.
- `apps/api`: the member-cap route's auth guard and resolution, and invite
  routes mapping `member_cap_reached` to a 403 with the nudge.

## Follow-up noticed while tracing this (not in this change)

Self-serve records carry explicit `maxStorageBytes: 250 MB` overrides, and an
explicit override beats a plan default in `resolveEffectiveLimits` — so
upgrading a self-serve workspace to Pro may not lift its storage cap. To be
verified and filed separately.
