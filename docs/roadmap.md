# Roadmap

- **MCP server** — the primary users are agents, so expose upload/list/delete
  as MCP tools (Cloudflare's `McpAgent` on the same worker, or a sibling
  worker on `mcp.uploads.sh`), authenticated per workspace like REST.
- **Presigned upload URLs** (`POST /v1/sign`) via files-sdk `signedUploadUrl()`
  — needs the hybrid-mode HTTP credentials above; lets clients PUT large files
  straight to the bucket.
- **Web UI**: files-sdk ships `createFilesRouter` + a browser client
  (`files-sdk/client`, `files-sdk/hono`) — mount it in the worker and the Astro
  app gets list/upload/download against the same bucket with per-operation
  authorization, without hand-rolling more REST.
- **Key/path governance** — today any authenticated client can write to any
  key in its workspace's bucket, which is fine for an internal audience but
  not long-term (especially in `uploads-default`). Future passes:
  - Bare filenames (no `/`) get an auto-generated unique prefix (e.g.
    `f/<shortid>/shot.png`) instead of landing in the bucket root — the root
    should never accumulate a million loose objects.
  - Typed destinations: a category like `screenshots` routes to its own
    prefix convention automatically (what the github-screenshots skill does
    by hand today with `screenshots/<repo>/<ref>/…`).
  - Per-workspace key policy in the registry record (allowed prefixes,
    max depth, reserved roots) enforced at upload time.
- **Encrypt BYO-bucket credentials at rest** — workspace records for external
  buckets carry S3 keys in KV; before opening to outside tenants, wrap those
  fields with an encryption key held as a Worker secret so KV read access
  alone doesn't yield credentials.
- **More providers**: add cases to `packages/storage` (`s3`, `gcs`, …).
- **Point `github-screenshots` at this API** — replaces its bundled SigV4
  script with one authenticated PUT.