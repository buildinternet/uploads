# Roadmap

Where the project is headed lives in [VISION.md](../VISION.md#roadmap) — that
is the direction document, kept current. This file tracks the smaller, concrete
items that are on the list but not yet built.

## Open items

- **More storage providers** — the storage layer is provider-agnostic
  (files-sdk via `createStorage()` in `packages/storage`); R2 and any
  S3-compatible bucket are wired up. Adding `gcs` and others is one new case
  plus peer deps.
- **Full web file management** — longer-term, files-sdk's `createFilesRouter`
  and browser client could power full browse/manage in the web app.
- **Key-policy polish** — destination-specific size rules, and exposing a
  workspace's key policy (`allowedKeyPrefixes`, `maxKeyDepth`) on `usage` and
  `doctor` output.
- **Enrollment "token used" notify** — org-membership accepts already email
  the inviter; the secondary CLI enrollment path (`/admin/enrollments` →
  `/invite#code`) has no durable inviter identity. Low priority.
- **Encrypt-at-rest migration** — BYO-bucket credentials encrypt when
  `WORKSPACE_SECRETS_KEY` is set; existing plaintext records still need a
  re-write pass, and key rotation needs care.

## Recently shipped

Larger items that used to live here and are now in production: self-serve
workspace registration, local and hosted MCP servers, presigned upload URLs,
typed key destinations (`f/` / `screenshots/` / `gh/`), the daily retention
cron, and non-guessable private-repo attachment URLs
([private-attachments](private-attachments.md)).
