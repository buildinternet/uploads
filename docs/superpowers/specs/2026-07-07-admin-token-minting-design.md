# Admin token minting — design

**Status:** approved, pre-implementation
**Date:** 2026-07-07
**Scope:** throwaway proof-of-concept; to be replaced by a real auth system
(e.g. Better Auth). Goal is only to get the basic mint-a-token workflow working
against the deployed API.

## Problem

Today a workspace record (`ws:<name>` in the `REGISTRY` KV namespace) stores a
single `tokenHash`. The only way to get a token is `add-workspace.mjs`, which
overwrites the entire record — so there is no way to:

- issue more than one valid token for a workspace, or
- mint a token for an existing workspace without a local `wrangler` + full-record
  rewrite.

We want to mint one or more upload tokens for a workspace over HTTP against the
deployed Worker, defaulting to the `default` (public) workspace.

## Approach

An authenticated admin endpoint on the Worker that appends a new token to a
workspace's record and returns the raw token once.

### 1. Record schema (`apps/api/src/workspace.ts`)

Replace the single hash with a list, while still honoring the legacy field on
read so no data migration is required:

```ts
export interface WorkspaceRecord {
  // ...existing fields...
  /** Bearer tokens valid for this workspace. */
  tokens?: { hash: string; label?: string; createdAt: string }[];
  /** @deprecated legacy single-token field; still honored on read. */
  tokenHash?: string;
}
```

Auth builds its candidate hash list as:

```ts
const hashes =
  record.tokens?.map((t) => t.hash) ??
  (record.tokenHash ? [record.tokenHash] : []);
```

and does a timing-safe compare of the presented token's hash against each
candidate. Behavior (uniform 401, hash-and-compare even for unknown
workspaces) is otherwise unchanged. The pre-existing `default` record keeps
working on its legacy `tokenHash` until it is next minted to.

### 2. Admin auth middleware (`apps/api/src/admin.ts`, new)

Mirrors `workspaceAuth`:

- Reads `Authorization: Bearer <token>`.
- Timing-safe compares against the `ADMIN_TOKEN` Worker secret.
- Uniform `401 { error: "unauthorized" }` on mismatch.
- **Fails closed:** if `ADMIN_TOKEN` is unset/empty, every request is rejected —
  the route is never open.

### 3. Endpoint (`apps/api/src/routes/admin.ts`, new; wired in `index.ts`)

`POST /admin/tokens`, mounted **outside** the `/v1/:workspace/*` tree.

- Body (optional JSON): `{ "workspace"?: string, "label"?: string }`.
  - Missing/empty `workspace` → `"default"`.
  - `workspace` validated against the existing name regex.
- Loads `ws:<name>`; **404** if the workspace does not exist. (This endpoint
  issues tokens for existing workspaces; it does not create them.)
- Mints `up_<workspace>_<base64url(24 random bytes)>`.
- Read-modify-write: appends `{ hash, label, createdAt }` (migrating a legacy
  `tokenHash` into the list on first append), `PUT`s the record back to KV.
- Returns `201 { workspace, token, label }`. Token shown once.

### 4. `add-workspace.mjs`

Write `tokens: [{ hash, label: "initial", createdAt }]` instead of `tokenHash`.
Still prints the token once. (Existing overwrite semantics for that script are
unchanged — it is workspace *creation*.)

### 5. Docs & env templates

- **README:** a short "actively developed — not production-ready" callout near
  the top, plus a public section documenting how to mint a token (set
  `ADMIN_TOKEN`, `curl POST /admin/tokens`), so open-source users can do it
  themselves.
- **Env templates** (safe to edit; real `.env`/`.dev.vars` are not touched):
  - `.env.example` — nothing required (client file), but note the admin flow
    where relevant.
  - `apps/api/.dev.vars.example` — add `ADMIN_TOKEN=` with a comment explaining
    it gates `/admin/*` and must also be set in prod via `wrangler secret put`.

## Testing (local, against `wrangler dev`)

Prereq (done by the user, not the agent): set `ADMIN_TOKEN` in
`apps/api/.dev.vars`.

1. `POST /admin/tokens` (no body) → mints for `default`; new token authenticates
   on `/v1/default/files`.
2. `POST /admin/tokens {"workspace":"<other>"}` → new token authenticates on that
   workspace.
3. A second mint for `default` → both tokens authenticate (append, not replace).
4. Pre-existing legacy `tokenHash` token still authenticates.
5. Missing/wrong admin bearer → 401.
6. Mint for a non-existent workspace → 404.

## Out of scope (deferred to the real auth system)

Listing tokens, revoking/expiring tokens, rotation, per-token scopes. Storing
each token as an object (not a bare hash string) keeps a future revoke endpoint
cheap, but no such endpoint ships here. A leaked PoC token is killed by editing
KV directly.
