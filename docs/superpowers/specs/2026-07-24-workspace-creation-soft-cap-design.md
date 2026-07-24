# Workspace-creation soft cap

A user may create at most **3 free workspaces**. Paid workspaces do not count
against the allowance, nor do legacy operator-provisioned ones. Enforced at
creation only — never retroactively, never a deletion trigger.

Alongside the cap, two adjacent fixes to the workspace index
(`/account/workspaces`): a whitespace bug in the "create one" link, and a
wider auto-open fallback so a signed-in user lands in a workspace instead of
a picker.

## Where the cap already exists

`POST /v1/workspaces` has enforced a cap of 3 since self-serve registration
shipped: `MAX_SELF_SERVE_WORKSPACES` in `apps/api/src/routes/workspaces.ts`,
counting owned memberships whose record carries `selfServe === true`, and
rejecting with `403 workspace_cap_reached`.

Two gaps: it counts paid workspaces against the allowance, and no UI surface
knows the cap exists, so a user at the limit discovers it only by filling in
the create form and being refused.

## Scope rule: which workspaces burn a slot

A workspace counts against a user's allowance when **all** hold:

- the user's org role for it is `owner` (not `admin`, not `member`), and
- the record is `selfServe === true`, and
- it resolves to the free plan — `getPlan(record.plan).id === "free"`, which
  fails open to free for an absent or unrecognized plan string.

Everything else is exempt: Pro workspaces, legacy/operator-provisioned
records (no `selfServe` flag), the communal `default` workspace, and any
workspace the user merely belongs to. Invitations are unaffected — a user
may be a member of any number of workspaces.

This mirrors `member-cap.ts`'s reasoning about `selfServe` versus `plan`.
`plan` is written only by Stripe or an operator; self-serve provisioning
writes free's numeric limits and no `plan` field. `selfServe` is therefore
the honest signal for "a free tenant that never had a plan stamped on it",
and `getPlan`'s fail-open keeps such a record on the free side of the test.

### Consequences, accepted deliberately

- **Upgrading frees a slot immediately.** A user at 3 who takes one to Pro
  can create a fourth the moment the plan lands on the record.
- **Downgrading can leave a user over the cap.** Three free workspaces plus
  a lapsed Pro is four owned free workspaces. Nothing is deleted, disabled,
  or reclaimed; the user simply cannot create another until they are back
  under 3. The cap is a creation gate, and only that.
- **No per-user operator override.** The escape hatch for comping an
  exception is editing a workspace record (clear `selfServe`, or apply a
  plan), which is how the adjacent limits are comped today. A dedicated
  per-user allowance is not worth the surface area at a cap of 3.

## Architecture

### 1. `packages/billing/src/workspace-cap.ts` (new)

Pure, no I/O, so the API guard and any future surface share one answer to
"may this user create another workspace". Sibling to `member-cap.ts`, which
it deliberately resembles.

```ts
export const MAX_SELF_SERVE_WORKSPACES = 3;

/** The subset of a workspace record the cap needs. */
export interface WorkspaceCapRecord {
  plan?: string;
  selfServe?: boolean;
}

export interface WorkspaceCreateQuota {
  /** Cap-eligible workspaces the user owns. May exceed `cap` after a downgrade. */
  used: number;
  cap: number;
  allowed: boolean;
}

export function countCapEligibleWorkspaces(
  records: readonly (WorkspaceCapRecord | null | undefined)[],
): number;

export function resolveWorkspaceCreateQuota(
  ownedRecords: readonly (WorkspaceCapRecord | null | undefined)[],
): WorkspaceCreateQuota;

/** The note shown at the cap. */
export function workspaceCapMessage(cap: number): string;
```

Callers pass records for workspaces the user owns; the role filter stays at
the call site, where membership data lives. A `null` record (KV miss) does
not count — it cannot be shown to be cap-eligible, and failing open here
matches the rest of the module's posture.

### 2. `POST /v1/workspaces`

Drops the local `MAX_SELF_SERVE_WORKSPACES` and the inline
`records.filter(r => r?.selfServe === true)` count in favour of
`resolveWorkspaceCreateQuota`. Same 403, same `workspace_cap_reached` code,
same message shape — now paid-exempt. The re-export of
`MAX_SELF_SERVE_WORKSPACES` from `apps/api/src/routes/workspaces.ts` is kept
so existing importers and tests are unaffected.

This remains the **only** enforcement point. Everything below is UI, and the
UI failing open must never grant a fourth workspace.

### 3. `GET /me/workspaces`

Gains a sibling field to `workspaces`:

```json
{ "workspaces": [...], "workspaceCreate": { "used": 3, "cap": 3, "allowed": false } }
```

The handler already loads every membership's record for `plan` and
`publicBaseUrl`, so the count costs no extra KV reads — it filters the
records it is already holding down to `role === "owner"` and calls the
helper.

Purely additive. `api-client.ts` parses it defensively, and **absent means
allowed**: an older API build, a malformed field, or a partial outage
degrades to today's behaviour (create affordances shown, server still
enforcing) rather than locking a user out of something they are entitled to.

The quota rides the existing `sessionStorage` workspace cache
(`writeCachedWorkspaces`) so the optimistic first paint does not flash the
wrong dropdown row before revalidation.

## UI

### Switcher dropdown (`renderSwitcherMenuHtml`)

One row, whichever state applies — never both:

- **Under the cap:** `+ new workspace` → `/account/workspaces/new`, as today.
- **At the cap:** `manage workspaces` → `/account/workspaces?manage=1`.

Keeping create out of the dropdown at the cap is the point: the affordance
should not sit there permanently offering something that will be refused.

### Workspace index (`/account/workspaces`)

- `?manage=1` suppresses the auto-open (see below) and always renders the
  list, so "manage workspaces" does not bounce straight back out.
- **Under the cap:** the existing sentence, "Choose a workspace, or create
  one."
- **At the cap:** the create link is replaced by a muted note — "Free
  accounts include 3 workspaces. Upgrade one to Pro to create another."
- **Padding fix:** in `workspaces.astro` the word `or` and the following
  `<a>` sit on separate source lines, and Astro collapses the newline away,
  rendering `orcreate one` with the underline flush against the preceding
  word. Fixed with an explicit `&#32;`, not by reflowing to one long line.
  The empty-state string in the same file already reads correctly and is
  left alone.

### Create page (`/account/workspaces/new`)

Directly linkable and bookmarkable, so it checks the quota on load rather
than trusting that no entry point led here. At the cap it renders the form
disabled with the same note, turning a submit-then-403 into an up-front
explanation. If the quota is absent or the fetch fails the form stays
enabled — the server is the backstop.

## Redirect: land in a workspace, not a picker

`resolveDefaultWorkspace` today returns the sole membership, or the
last-used slug from `localStorage` when it is still a valid membership, and
otherwise `null` (show the picker). A user with several memberships and no
stored slug — a fresh browser, cleared storage, a first visit after being
invited — lands on the picker every time.

New final fallback, applied only when the existing two miss: the first
membership with role `owner`, else the first with role `admin`, else the
first entry, in the order `/me/workspaces` returns. `null` is now returned
only when there are no memberships at all.

Suppressed entirely when `?manage=1` is present, which is what makes the
index reachable on purpose.

Last-used continues to be recorded by `resolveSidebarWorkspace` on every
workspace route visit, so the fallback matters only on the first visit; after
that the stored slug wins.

## Testing

`packages/billing/test/workspace-cap.test.ts`:

- three free self-serve owned records → `allowed: false`, `used: 3`
- two free + one Pro → `allowed: true`, `used: 2`
- non-`selfServe` (legacy/operator) records never count
- absent/unrecognized `plan` on a `selfServe` record counts (fail-open-to-free)
- four free records after a downgrade → `used: 4`, `allowed: false`, no throw
- `null` records are skipped
- boundary: 2 → allowed, 3 → denied

`apps/api/src/routes/workspaces.test.ts`:

- the existing cap test still passes unchanged
- new: three owned self-serve workspaces where one is Pro → 201, not 403
- new: owned non-self-serve workspaces do not block creation

`apps/api/src/routes/me.test.ts` (or the nearest existing suite):

- `workspaceCreate` present and correct for a capped and an uncapped user
- `used` counts only owned workspaces, not every membership

Web unit tests:

- `resolveDefaultWorkspace` — owner-first fallback, admin fallback, first-entry
  fallback, unchanged single-membership and last-used paths, empty → `null`
- `renderSwitcherMenuHtml` — create row under the cap, manage row at the cap,
  never both; absent quota renders the create row
- `api-client` — `workspaceCreate` parsed, absent field reads as allowed,
  malformed field reads as allowed

## Docs

`docs/workspaces.md` gains a short section: the cap, the scope rule (owned +
self-serve + free), that Pro is exempt and upgrading frees a slot, that a
downgrade can leave a user over the cap without consequence, and that an
operator comps an exception by editing the workspace record.

The public `/docs/limits` page is deliberately left alone — the cap is a
per-account creation gate, while that page documents per-workspace limits,
and mixing the two would muddle a page whose framing is "limits apply per
workspace, not per user".
