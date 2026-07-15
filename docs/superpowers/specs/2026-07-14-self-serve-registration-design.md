# Self-Serve Registration — Design

- **Date:** 2026-07-14
- **Status:** Approved
- **Scope:** Let new users sign up and get a working workspace without operator involvement, using shared-bucket prefix workspaces. Ships the personal-workspace path first; the same endpoint supports creating additional workspaces (design "C", ship "A" first).

## Background

Today workspace creation is operator-only: the KV `ws:<name>` record is written by `apps/api/scripts/add-workspace.mjs`, and the backing Better Auth organization is created via the service-binding-only `/internal/orgs` route. Better Auth personal-org auto-provisioning was deliberately disabled (D4). Users can only _join_ existing workspaces via org invitations or enrollment codes.

The storage substrate already supports self-serve: shared-bucket workspaces (`bucket: uploads-default`, `prefix: <name>/`, `publicBaseUrl: https://storage.uploads.sh`) are a pure KV write, and tenant isolation is structural — every request resolves a workspace record and receives a `Files` store hard-scoped to its prefix (`apps/api/src/storage.ts` → `packages/storage/src/index.ts` `createStorage`). A token for workspace A cannot address keys under `B/`.

## Decisions

### D1. Identity gate: GitHub required for self-serve

Self-serve registration requires GitHub sign-in (the Better Auth `github` social provider, already configured). Magic-link remains available for invited users joining existing workspaces. Enforcement point: the provisioning endpoint requires the session's user to have a linked GitHub account — no schema changes, no signup-source tracking.

Rationale: GitHub accounts are a cheap sybil dampener, the audience universally has one, and the handle gives a natural personal-workspace slug.

### D2. Public stance: shared-bucket public URLs, stated plainly

Self-serve workspaces are shared-bucket, public-URL workspaces. Files get public, unguessable URLs (`https://storage.uploads.sh/<name>/f/<id>/<file>`); this is stated at workspace creation. Per-file `objectVisibility` continues to gate the metadata/file-page layer only. Private storage is deferred to a future dedicated/BYO tier — **no new serving path in this project**.

### D3. Abuse posture: open signup, conservative defaults

Anyone with a GitHub account can sign up. Self-serve workspaces get tight defaults, enforced via the existing `workspace_usage` / limits machinery:

- Storage quota: ~1 GB
- Per-file size cap: 25 MB
- Modest daily upload budget (pick a value consistent with existing budget fields)
- Per-user workspace cap: 3 (personal + created)

Raising limits is admin-only. Workspace deletion is out of scope for v1 (admin-only), avoiding slug-recycling and orphaned-bytes questions.

### D4. Creation is explicit-but-one-click, not silent

No silent auto-provisioning at signup. After first GitHub sign-in, onboarding (web `/account` and CLI `uploads login`) offers a one-click "create your workspace" pre-filled with the GitHub handle (collision → suffix, e.g. `-1`). Personal and additional workspaces use the same endpoint and code path. This avoids orphan workspaces from drive-by sign-ins.

## Components

### Provisioning endpoint — `POST /v1/workspaces` (apps/api)

Session-authed (same `sessionAuth` used by `POST /v1/tokens`). Lives in `apps/api` because it owns REGISTRY KV. Behavior:

1. **Validate slug:** `WS_NAME_RE`, plus a reserved-names list (at minimum: `default`, `admin`, `api`, `www`, `storage`, `embed`, `auth`, `mcp`, `f`, `public`, `account`, `me`, `invite`).
2. **Require GitHub-linked account** on the session user (via the `AUTH` service binding).
3. **Enforce per-user cap:** count orgs where the user is `owner` and which back self-serve workspaces; reject at 3.
4. **Uniqueness guard:** check both the org slug (auth D1) and KV `ws:<name>` are free before creating.
5. **Create org** via the existing `AUTH` service binding `/internal/orgs`, with the caller as `owner`.
6. **Write KV record** `ws:<name>` with shared-bucket defaults plus `selfServe: true` and the D3 limits.
7. **Rollback:** if the KV write fails, delete the org (compensating action; requires an internal org-delete route if one doesn't exist). A slug race simply fails one side and rolls back — no distributed transaction needed.

Response: the workspace summary the client needs to proceed (name, public base URL, next-step hint to mint a token).

### Web UI (apps/web)

- `/account`: "Create workspace" flow — slug input pre-filled from GitHub handle, public-URL disclosure copy, limits summary.
- Post-first-sign-in onboarding variant surfaces the same flow one-click.

### CLI (packages/uploads)

`uploads login` for a user with zero workspaces offers workspace creation (calls `POST /v1/workspaces` with the session bearer, then proceeds to the existing token-mint flow).

### Unchanged

Dedicated/BYO workspaces remain operator-provisioned via `add-workspace.mjs`. Invitations, enrollment codes, admin surfaces, token minting, and all serving paths are untouched.

## Error handling

- Slug invalid / reserved / taken → 400/409 with a machine-readable code so web and CLI can prompt for another name.
- No GitHub account linked → 403 with a code directing the client to the GitHub-connect flow (already exists post-magic-link).
- Cap reached → 403 with code.
- Org created but KV write failed and rollback also failed → 500; log loudly; admin cleans up (rare, and the org without a KV record is inert).

## Testing

- Unit tests on the provisioning route: slug validation, reserved names, GitHub-required gate, cap enforcement, rollback on KV failure.
- Integration test against fake-D1 following the device-flow test patterns (`docs`/existing test setup for seeded sessions).
- Manual prod verification: GitHub sign-up → create workspace → `uploads login` → `uploads put` → public URL fetch.

## Implementation approach

Agent-coordinated: independent task lanes (API route + internal auth changes; web UI; CLI onboarding; docs) executed by subagents with the main session orchestrating and integrating. Detailed plan to follow via the writing-plans process.
