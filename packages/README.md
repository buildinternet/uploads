# packages

Shared libraries consumed by `apps/api` and published/used from the CLI.

| Directory  | Package                  | Role                                                               |
| ---------- | ------------------------ | ------------------------------------------------------------------ |
| `storage/` | `@uploads/storage`       | files-sdk adapter factory — single entry point for all storage I/O |
| `uploads/` | `@buildinternet/uploads` | CLI (`uploads` bin) + programmatic client for GitHub image embeds  |

Rule: route code never imports files-sdk adapters or touches R2 bindings directly — always go through `createStorage()` in `@uploads/storage`.
