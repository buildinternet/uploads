# In-app per-workspace limit editing (admin panel)

**Date:** 2026-07-20
**Status:** Approved design, pre-implementation

## Problem

Per-workspace resource limits (`maxStorageBytes`, `maxUploadsPerPeriod`,
`maxUploadBytes`, `maxVideoUploadBytes`) can only be changed today by running
`apps/api/scripts/set-workspace-limits.mjs` from an operator's machine, which
mutates the KV `WorkspaceRecord` directly through wrangler. There is no
server-side write path and no UI. Operators need to adjust a single tenant's
caps (raise a heavy user, or tighten an abuser) without shell access.

This work adds in-app editing of the four numeric **budget** limits to the
admin panel's Workspaces view.

## Scope

**In scope** — editing these four fields per workspace:

- `maxStorageBytes`
- `maxUploadsPerPeriod`
- `maxUploadBytes`
- `maxVideoUploadBytes`

Each field can be set to a positive integer, or cleared to **unlimited**
(the field is deleted from the record; omission = unlimited is the existing
convention in `workspace.ts`).

**Out of scope** (deferred; the CLI script still covers these):

- `retentionDays`, `allowedKeyPrefixes`, `maxKeyDepth` (key-policy).
- A token-gated `/admin/*` twin of the endpoint (only the session-cookie
  `/admin-ui/*` surface is built now).
- Audit logging of limit changes.

## Surface & auth

Extend the existing Workspaces panel rather than adding a new page. That panel
already talks to `/admin-ui/*`, which is gated by session cookie +
`requireAdminUser` (global `admin` role) — see
`apps/api/src/routes/admin-ui.ts:99-100`. No new auth is introduced.

Two new endpoints, added to `admin-ui.ts`:

### `GET /admin-ui/workspaces/:name/limits`

Returns the current budget-limit fields plus current usage so the operator can
judge headroom before editing.

Response:

```jsonc
{
  "workspace": "acme",
  "limits": {
    "maxStorageBytes": 250000000, // number, or null = unlimited
    "maxUploadsPerPeriod": 3000,
    "maxUploadBytes": 25000000,
    "maxVideoUploadBytes": 8000000,
  },
  "usage": {
    "bytes": 128000000, // current stored bytes
    "uploads": 412, // uploads this UTC period
  },
}
```

- Limit values are read raw from the KV record; a field absent on the record is
  reported as `null` (unlimited).
- `usage` reuses the same usage-loading path as
  `GET /me/workspaces/:name/usage` (`apps/api/src/routes/me.ts:170-182` →
  `usageWithLimits` / the underlying usage read in `budget.ts`). If the usage
  read fails, `usage` is returned as `null` rather than failing the whole
  request — the limits are the primary payload.
- Unknown workspace → 404 `workspace_not_found`.

### `PATCH /admin-ui/workspaces/:name/limits`

Validates and writes. Mirrors the existing `oauth-clients` PATCH shape in the
same file.

Request body — every field optional; when present, a positive integer or
`null`:

```jsonc
{
  "maxStorageBytes": 250000000, // set the cap
  "maxUploadsPerPeriod": null, // clear → unlimited (deletes the field)
  "maxUploadBytes": 25000000,
  // omitted maxVideoUploadBytes → left unchanged
}
```

Semantics (identical to `set-workspace-limits.mjs`'s patch/clear behavior,
moved server-side):

1. `loadWorkspaceRecordRaw(env, name)` (`workspace.ts:187-193`) — raw read, no
   `cacheTtl`, so we edit the freshest record. 404 if not found.
2. For each **present** field: a number sets `record[field] = n`; `null`
   deletes `record[field]`. Omitted fields are untouched.
3. `REGISTRY.put(\`ws:${name}\`, JSON.stringify(record))` — the whole record is
written back, so all non-budget fields (`retentionDays`,
`allowedKeyPrefixes`, `maxKeyDepth`, `provider`, `bucket`, `prefix`, org
   linkage, etc.) are preserved.

Response: `200` with the same shape as GET (post-write limits + usage).

## Validation

A small, unit-tested helper — new module `apps/api/src/workspace-limits.ts`,
kept separate from the route so it's testable in isolation and a future
token-gated `/admin` endpoint can reuse it.

`validateLimitsPatch(body: unknown): LimitsPatch` rules, per field:

- Value must be one of: a finite integer `>= 1`, or `null`.
- Reject (400 `ValidationError`, `code: "invalid_limit"`): `NaN`, `Infinity`,
  negative, zero, non-integer, boolean, string, object, array.
- Unknown keys in the body are ignored (only the four known fields are read).
- No cross-field validation (e.g. per-file cap vs storage cap) — YAGNI.

The parsed result is a `Partial<Record<Field, number | null>>` containing only
the fields that were present in the body.

## UI

In the expanded workspace row of `apps/web/src/pages/admin/index.astro`, add a
**Limits** section, loaded lazily on `<details>` expand (same pattern as the
members/invites load at `index.astro:99-136`).

- On expand, `GET .../limits`; render four rows, each: label, a **number
  input**, and an **Unlimited** checkbox. Checking Unlimited disables the input
  and marks the field to send `null`.
- Byte fields (`maxStorageBytes`, `maxUploadBytes`, `maxVideoUploadBytes`) get a
  **unit dropdown** (MB / GB / GiB); the browser converts the input + unit to a
  byte integer before sending. `maxUploadsPerPeriod` is a plain integer input.
- A **Save limits** button PATCHes the four fields, then shows a success message
  noting **"changes apply within ~60s"** (the KV `cacheTtl ≈ 60s` caveat that
  `set-workspace-limits.mjs:265` also prints).
- Optionally display the returned `usage` inline ("128 MB of 250 MB used") when
  present, to give the operator context. Non-blocking if usage is null.
- Errors surface in a per-row/per-form status element, matching the existing
  invite-form error handling.

Styles added to `apps/web/src/styles/admin-workspaces.css`.

### Byte formatting/parsing (browser)

- Display: pick a friendly unit for the current value (e.g. `250000000` →
  `250` + `MB`). Decimal units (MB = 1000², GB = 1000³) as the default to match
  how the limits are authored; GiB offered for binary sizing.
- Parse: `value * unitMultiplier`, `Math.floor` to an integer byte count before
  sending. Empty input with Unlimited unchecked is a client-side validation
  error ("enter a number or check Unlimited").

## Testing

API tests (new `apps/api/test/admin-ui-limits.test.ts` or alongside existing
admin-ui tests), mirroring `apps/api/test/routes-budget.test.ts` and
`apps/api/src/routes/me.test.ts`:

1. `GET` returns current limit fields + usage; a workspace with an absent field
   reports it as `null`.
2. `PATCH` with numbers sets the fields on the KV record.
3. `PATCH` with `null` clears a field (record no longer has the key).
4. `PATCH` with an omitted field leaves it unchanged.
5. **Preservation:** a limits `PATCH` leaves non-budget fields
   (`allowedKeyPrefixes`, `retentionDays`, `maxKeyDepth`) intact on the record.
6. Validation: negative / zero / non-integer / string / boolean values → 400.
7. Auth: a non-admin session → 403; unauthenticated → 401 (whatever the shared
   `requireAdminUser` chain already returns).
8. Unknown workspace → 404.

`validateLimitsPatch` gets direct unit tests for the accept/reject matrix.

Frontend verified manually in the browser preview (load, edit, save, unlimited
toggle, error path).

## Files touched

- `apps/api/src/workspace-limits.ts` — **new**; `validateLimitsPatch` + types.
- `apps/api/src/routes/admin-ui.ts` — add GET + PATCH `/workspaces/:name/limits`.
- `apps/api/test/admin-ui-limits.test.ts` — **new**; endpoint tests.
- `apps/api/src/workspace-limits.test.ts` — **new**; validator unit tests.
- `apps/web/src/pages/admin/index.astro` — Limits UI in the expanded row.
- `apps/web/src/styles/admin-workspaces.css` — Limits form styles.

## Notes / caveats

- Edits take up to ~60s to take effect on serving reads (KV `cacheTtl: 60` in
  `loadWorkspaceRecord`, `workspace.ts:165-179`). Surfaced in the UI.
- This only affects the targeted workspace's record; there is no bulk edit and
  no change to the self-serve defaults (`self-serve-defaults.ts`).
