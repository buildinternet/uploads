# packages

Shared libraries consumed by `apps/api` and published/used from the CLI.

| Directory         | Package                   | Role                                                               |
| ----------------- | ------------------------- | ------------------------------------------------------------------ |
| `email/`          | `@uploads/email`          | Shared invite / notify email card HTML (API enrollment + auth org) |
| `errors/`         | `@uploads/errors`         | Shared error taxonomy + wire envelope (`AppError`, codes, types)   |
| `comment-config/` | `@uploads/comment-config` | Shared `.uploads.yml` parser and resolver for managed comments     |
| `comment-render/` | `@uploads/comment-render` | Shared managed-comment renderer and gh-key helpers                 |
| `storage/`        | `@uploads/storage`        | files-sdk adapter factory — single entry point for all storage I/O |
| `uploads/`        | `@buildinternet/uploads`  | CLI (`uploads` bin) + programmatic client for GitHub image embeds  |

Rule: route code never imports files-sdk adapters or touches R2 bindings directly — always go through `createStorage()` in `@uploads/storage`.

HTTP errors use the nested envelope from `@uploads/errors` — throw an `AppError`
subclass and let `respondError` / `onError` serialize it. Never hand-roll
`c.json({ error: "…" })`.
