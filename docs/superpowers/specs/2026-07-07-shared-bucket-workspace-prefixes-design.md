# Shared-bucket workspaces with per-workspace prefixes

**Date:** 2026-07-07
**Status:** Approved

## Problem

Today one workspace = one R2 bucket. On Workers that model doesn't scale:
R2 bindings are declared statically in `wrangler.jsonc`, so every new
bucket-backed workspace requires creating a bucket, adding a binding,
regenerating types, and redeploying — or minting per-bucket S3 credentials
for HTTP mode. Either way, workspace creation has infrastructure ceremony.

## Decision

Default workspaces become **prefixes in one shared bucket**
(`uploads-default`, bound as `UPLOADS_DEFAULT`, public at
`https://storage.uploads.sh`). Each workspace's objects live under
`<workspace-name>/` in that bucket. Creating a default-mode workspace is a
pure KV write — no infra side effects.

Bring-your-own-bucket remains supported as the advanced case: a workspace
record that points at a dedicated bucket (own binding or S3 credentials,
own `publicBaseUrl`) with no prefix. `buildinternet` (bucket
`buildinternet-dev`) stays exactly as it is and is the reference BYO case.

No workspace is special-cased in code. "Default mode" vs "BYO mode" is only
which fields the record carries.

## Design

### 1. Workspace record

`WorkspaceRecord` (apps/api/src/workspace.ts) gains an optional field:

```ts
/** Key prefix inside the bucket (e.g. "myws/"). All I/O is confined under it; clients never see it. */
prefix?: string;
```

- Must end with `/`; segments validated by the same rules as object keys
  (no empty, `.`, or `..` segments).
- Convention for shared-bucket workspaces: `prefix: "<name>/"`.
- BYO records omit it (empty prefix = whole bucket, today's behavior).

### 2. Storage layer

Prefixing is applied in exactly one place — the storage layer behind
`createStorage()` (`packages/storage`) — so route code in
`apps/api/src/routes/files.ts` is untouched and clients never see the
prefix.

- `StorageConfig` gains `prefix?: string`; `storageConfig()` in
  `apps/api/src/storage.ts` passes it through from the record.
- Writes/reads/head/exists/delete prepend the prefix to the client key.
- `list` uses the prefix as the base and strips it from returned keys.
- `publicUrl()` includes the prefix, so shared-bucket objects serve at
  `https://storage.uploads.sh/<workspace>/<key>`.
- Implementation note: check whether files-sdk supports a key prefix
  natively; if not, wrap the `Files` instance with a thin prefixing layer.

Safety: `badKey` in `routes/files.ts` already rejects `..` and empty
segments before keys reach storage, which is what makes blind prefix
prepending safe. The prefix layer gets unit tests proving a workspace
cannot read, write, delete, or list outside its prefix.

### 3. Provisioning

`apps/api/scripts/add-workspace.mjs` (and the setup wizard defaults) flip
polarity:

- **No `--bucket` flag (new default):** `bucket: uploads-default`,
  `binding: UPLOADS_DEFAULT`, `prefix: "<name>/"`,
  `publicBaseUrl: https://storage.uploads.sh`.
- **`--bucket <name>` (BYO mode):** today's behavior — dedicated bucket,
  optional `--binding`, credentials from flags/env, no prefix.

Default-mode records may still carry the shared bucket's S3 credentials
(from env, as today) — the binding handles I/O, credentials only enable
presigning. Presigned URLs are bucket-scoped, not prefix-scoped, so
presigning against the shared bucket is deferred until the prefix layer
constrains it; nothing currently depends on it.

### 4. Existing data / migration

None needed. The `default` workspace has no user base; re-register it as a
prefixed shared-bucket workspace. The existing `screenshots/` content in
`uploads-default` (~196 B) is moved under `default/` by hand or dropped.
`buildinternet` is unchanged.

### 5. Future direction (acknowledged, not built)

Per-workspace subdomains (`<name>.uploads.sh`) later: a small routing
worker mapping host → `uploads-default/<name>/`. The prefix convention is
exactly that mapping key, so nothing in this design needs undoing.

## Trade-offs accepted

- Isolation is logical (prefix) rather than physical (bucket); the prefix
  layer's tests are the guardrail.
- Per-workspace metrics/quotas aren't free; R2 lifecycle rules can still
  scope to a prefix.
- Shared-domain public URLs expose the workspace name in the path —
  considered a feature (self-describing URLs).

## Testing

- Unit tests for the prefix layer: key mapping on all operations, list
  stripping, no escape outside the prefix, `publicUrl` composition.
- Existing route behavior unchanged for records without `prefix`
  (BYO regression coverage).
