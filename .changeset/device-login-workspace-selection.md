---
"@buildinternet/uploads": minor
---

Device login now picks the workspace in the browser. `uploads login` works with
no flags for every account — the approval page lists the workspaces you can use,
creates one if you have none, and refuses to approve a workspace your account
can't reach instead of reporting success and failing in the terminal.
`--workspace` becomes an optional preselect; `--workspace <name> --create` still
provisions by name.
