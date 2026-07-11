# Roadmap

- **MCP server** — shipped in both variants: a local stdio server in the CLI
  (`uploads mcp`, tools mirror the CLI commands) and a remote worker on
  `agents.uploads.sh` (alt `mcp.uploads.sh`) (`apps/mcp`, standalone worker, per-workspace bearer auth
  like REST, put/list/delete/health).
- **Presigned upload URLs** — shipped as `POST /v1/:workspace/files/sign`
  (files-sdk `signedUploadUrl()`; needs HTTP S3 credentials on the workspace).
- **Web UI** — lightweight browser console at `/console` on the Astro site;
  longer-term: files-sdk `createFilesRouter` + browser client for full browse/manage.
- **Key/path governance** — bare keys → `f/<shortid>/<name>`; typed destinations
  (`screenshots` / `gh` / `f`); optional `allowedKeyPrefixes` + `maxKeyDepth` on
  put/sign. Remaining ideas: destination-specific size rules; expose policy on
  `usage`/`doctor`.
- **Encrypt BYO-bucket credentials at rest** — shipped when
  `WORKSPACE_SECRETS_KEY` is set (`enc:v1:…` AES-GCM on access/secret keys).
  Re-write existing plaintext records to encrypt; rotate key carefully.
- **Retention cron** — daily Worker cron sweeps workspaces with `retentionDays`.
- **More providers**: add cases to `packages/storage` (`s3`, `gcs`, …).
- **Point `github-screenshots` at this API** — replaces its bundled SigV4
  script with one authenticated PUT.
- **Private-repo embed privacy** — today every hosted file is on a public CDN;
  `--pr`/`--issue` keys are predictable (`gh/<owner>/<repo>/pull/<n>/<name>`),
  so attachments on private repos are not secret from anyone who can guess the
  URL. Future options: signed/time-limited URLs, repo-scoped auth at the edge,
  or non-guessable keys while keeping stable overwrite semantics.
