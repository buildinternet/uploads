# @uploads/storage

Provider-agnostic storage factory built on [files-sdk](https://files-sdk.dev). Used exclusively by `@uploads/api` — route handlers call `createStorage()`, not R2 or S3 directly.

## API

- `createStorage(config)` — returns a scoped `Files` instance for the workspace's provider/bucket/credentials
- `publicUrl(config, key)` — build a public CDN URL when `publicBaseUrl` is set

Workspace key prefixes (e.g. `myws/`) are applied here via files-sdk's instance `prefix`, so callers pass logical keys only.

## Adding a provider

1. Extend `StorageProvider` and add a `case` in `createStorage()`
2. Add the files-sdk adapter as a peer/dependency
3. Map fields from `WorkspaceRecord` in `apps/api/src/storage.ts`

## Commands

```bash
pnpm typecheck
pnpm test
```
