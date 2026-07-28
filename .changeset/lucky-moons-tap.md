---
"@buildinternet/uploads": minor
---

Show a runnable example when a command is missing an argument. `uploads put`
now answers `error: put requires at least one file` followed by
`uploads put ./shot.png --pr 123`, so the fix is copy-pasteable instead of one
`--help` away. Applies to put, attach, find, delete, meta, gallery, comment,
screenshot, annotate, and config set, plus the unknown-subcommand errors. With
`--json` the example comes back as an `example` field on the error payload.
