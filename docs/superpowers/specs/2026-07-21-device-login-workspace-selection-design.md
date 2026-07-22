# Device login: workspace selection at approval time

Issue: [#362](https://github.com/buildinternet/uploads/issues/362). Related: #183 (multi-workspace CLI profiles), #231 (the OAuth consent picker this mirrors).

## Problem

`uploads login --workspace default --force`, run by a user with no membership in
`default`, tells the user two contradictory things: the `/device` page shows
"Device approved. Return to your terminal — you're signed in", and the terminal
then fails with `no access to this workspace`.

The split exists because the workspace is resolved entirely CLI-side _after_ the
device token exchange (`resolveMintWorkspace`, `packages/uploads/src/commands/login.ts`).
`POST /device/code` carries only `client_id`, so the approval page has no idea
which workspace the terminal asked for and cannot validate it.

A second, related failure: an account with two or more workspaces cannot run a
bare `uploads login` at all — it hard-errors with `multiple workspaces available
(a, b); pass --workspace <name>`. The CLI demands a decision the user is best
positioned to make in the browser, where they are already authenticated and can
see their actual options.

## Approach

Move workspace selection to the `/device` approval page and make the browser
authoritative. This follows the Stripe CLI pattern (browser-side account picker
during `stripe login`), which is the right precedent because — like Stripe's —
our credentials are tenant-scoped at mint (`up_<workspace>_…`), so login cannot
defer tenant choice the way `gh`/`vercel`/`gcloud` do.

`--workspace` demotes from selector to optional preselect. It is not removed:
`--workspace <name> --create` provisions a _named_ workspace, which a picker of
existing workspaces cannot express, and #183 would give the flag a genuine
client-side meaning ("add this profile").

## Wire format: the device-code `scope` field

better-auth's `device_code` row already has a `scope` column that the plugin
stores verbatim from `POST /device/code` and echoes back to the client in the
device-token response (`scope: claimedDeviceCode.scope || ""`, see the plugin's
`routes.mjs`). That is a per-login channel in both directions, with no new
table:

- **Outbound** — the CLI sends `scope: "workspace:acme"`, or
  `"workspace:acme create"` with `--create`. No `--workspace` means no scope.
- **Inbound** — the page writes the final choice onto the same row; the CLI
  reads `workspace:<slug>` out of the token response's `scope`, which
  `requestDeviceToken` already surfaces as `DeviceTokenResult.scope`.

Rejected alternatives:

- **A `?workspace=` URL parameter.** A crafted link could then misrepresent what
  the terminal requested. Server-side storage cannot be spoofed.
- **Reusing `oauth_workspace_choice`.** That row is user-global and feeds
  `postLogin.consentReferenceId`, so a CLI login would silently re-scope
  unrelated OAuth/MCP grants and force re-consent. Binding to the device row
  keeps this login's choice local to this login.
- **A dedicated `device_workspace_choice` table plus a `selected` field on
  `GET /v1/tokens`.** More moving parts and a second round trip for the same
  result; its only advantage is not depending on better-auth's `scope`
  behavior.

The format needs a parser in both `apps/auth` and `packages/uploads`. Those
cannot share a module — `packages/uploads` ships with no workspace dependencies
by design. Two small `formatDeviceScope`/`parseDeviceScope` helpers, each
carrying a comment pointing at the other, following the existing
`membershipSlugs` / `resolveWorkspaceClaims` precedent in `apps/auth`.

## Components

### 1. `apps/auth/src/device-workspace.ts` (new)

A better-auth plugin, `deviceWorkspacePlugin(db)`, modeled on
`workspace-choice.ts` and registered alongside it in `auth.ts`.

- `GET /device/workspace?user_code=…` — session required. Returns
  `{ requested: string | null, create: boolean, workspaces: [{ slug, name }] }`.
  `requested`/`create` are parsed from the row's `scope`; `workspaces` is the
  caller's `member ⋈ organization` join, oldest membership first (same query and
  ordering as `membershipSlugs`).
- `POST /device/workspace` `{ userCode, workspace }` — session required.
  Validates the slug against the caller's memberships and writes
  `scope = "workspace:<slug>"` on the row. A non-membership slug returns 400
  `invalid_workspace` rather than recording a workspace the user cannot use —
  same contract as `POST /oauth2/workspace-choice`.

Both endpoints are guarded to a row that is `pending`, unexpired, and whose
`userId` is null or the calling user — the same conditions better-auth's own
`/device/approve` enforces. Neither claims the row's `userId`; that stays with
the plugin's `GET /device`.

Ordering is safe by construction: the CLI cannot receive a token before the row
reaches `approved`, and the page writes `scope` strictly before calling
`/device/approve`, so the token exchange always echoes the final choice.

### 2. `apps/web/src/lib/device-workspace.ts` (new)

The panel-state decision as a pure function, unit-tested independently, keeping
`device.astro` thin — the pattern `session-device.ts` already sets.

```text
resolveDeviceWorkspaceState({ requested, create, memberships }) =>
  | { kind: "denied";    requested; memberships }
  | { kind: "provision"; requested }
  | { kind: "choose";    options; selected }
  | { kind: "first_run" }
```

- `denied` — a workspace was requested, `create` is false, and the user is not a
  member. This is the reported bug's case.
- `provision` — requested with `create`. Never blocks: the workspace legitimately
  may not exist yet, and the CLI provisions it after login.
- `choose` — one or more memberships. `selected` is the requested workspace when
  the user is a member of it, otherwise the oldest membership.
- `first_run` — zero memberships and nothing requested.

The page cannot distinguish "workspace does not exist" from "exists, you are not
a member", and must not try — the `denied` copy stays neutral: _"Your account
doesn't have access to a workspace named `default`."_

### 3. `/device` page (`apps/web/src/pages/device.astro`)

The confirm card gains a workspace block driven by the state above:

- `choose` — a `<select>` of workspaces plus a **New workspace…** option that
  reveals a name field. Preselected to `selected`. With exactly one workspace
  the select collapses to a read-only line naming it (consent-page precedent: no
  picker for a single option), with creation still reachable.
- `denied` — **replaces** the Approve/Deny actions with an error panel naming the
  requested workspace, listing the ones the user does have, and offering
  "approve with a different workspace" (reveals the picker) or creation. The
  success panel is unreachable in this state, which is the fix for ask 1.
- `provision` — an informational line ("`acme` will be created if it doesn't
  exist"); approval proceeds normally.
- `first_run` — the create form directly, no select.

Approve becomes a three-step sequence, aborting on any failure _before_ the
approve call so nothing is ever approved into the wrong workspace:

1. If creating: `createWorkspace(apiOrigin, name)` from `api-client.ts`. A
   `GITHUB_REQUIRED` error reuses the existing "Requires a linked GitHub
   account" + Connect GitHub affordance from `/account/workspaces/new`; other
   errors surface inline.
2. `POST /device/workspace` with the chosen slug — skipped in `provision`, where
   the CLI provisions.
3. `POST /device/approve`.

Success copy names the workspace: _"Device approved — signed in to `acme`.
Return to your terminal."_

**CSP.** `/device` uses `authPageCsp`, which deliberately omits the API origin.
Inline creation needs `POST /v1/workspaces` on the API worker, so the page moves
to a new `devicePageCsp(authOrigin, apiOrigin)` — `authPageCsp` plus the API
origin in `connect-src`, and nothing else. Deliberately not `signedInCsp`, which
also relaxes `img-src` to `https:`. `signed-in-page.test.ts` covers the new
helper; `authPageCsp` stays as-is for `/login` and `/accept-invitation`.

### 4. CLI (`packages/uploads`)

- `requestDeviceCode(authUrl, { clientId, scope })` sends the scope built from
  `--workspace`/`--create`.
- `pollForDeviceToken` returns `{ accessToken, scope }` instead of a bare string.
  `obtainDeviceAccessToken` keeps returning a string for `invite create`, which
  has no workspace to resolve.
- `resolveMintWorkspace` precedence becomes:
  1. the workspace echoed back in the token scope (the browser's decision),
  2. `--workspace` (with `--create` provisioning), for servers that echo nothing,
  3. the sole membership,
  4. zero memberships on a TTY — the existing create prompt,
  5. otherwise the "multiple workspaces" error.

  Steps 3–5 are now only reachable against a server predating this change.

- The `multiple workspaces available (…); pass --workspace <name>` error is no
  longer reachable in the normal path: a bare `uploads login` works for every
  account shape.
- Backstop for issue ask 1: a mint 403 is rewritten to name the workspaces the
  account can actually access, instead of the bare `no access to this workspace`.
- Help text reframes `--workspace` as an optional preselect ("skip the browser
  picker"), not a requirement.

Both compatibility directions are no-ops. An old CLI against the new server
ignores the echoed scope and mints as it does today. A new CLI against an old
server sees an empty scope and falls back to rule 2.

## Testing

- `apps/auth/src/device-workspace.test.ts` — against the node:sqlite fake-D1
  harness, per `device.test.ts`: scope round-trip, membership validation
  (non-membership → 400), a row belonging to another user, an expired row, an
  already-approved row, and the `requested`/`create` parse.
- `apps/web/src/lib/device-workspace.test.ts` — every branch of
  `resolveDeviceWorkspaceState`, including requested-and-a-member,
  requested-not-a-member, requested-with-create, and zero memberships.
- `apps/web/src/lib/signed-in-page.test.ts` — `devicePageCsp` contents.
- `packages/uploads/test/commands-login.test.ts` — scope format/parse round trip,
  the new `resolveMintWorkspace` precedence (echo wins over flag; flag wins when
  the echo is absent), and `pollForDeviceToken` surfacing scope.

## Out of scope

- Multi-workspace CLI profiles (#183). This mints one token as today; it only
  changes who chooses the workspace.
- Changing the server token model. Tokens stay single-workspace.
- The enrollment-code path (`--code`), which is workspace-bound by construction.

## Delivery notes

- A changeset for `@buildinternet/uploads` — CLI behavior and help text change.
- `docs/cli.md`'s login section documents browser-side selection and the
  demoted `--workspace`.
