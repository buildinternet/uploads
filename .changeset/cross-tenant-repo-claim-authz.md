---
"@buildinternet/uploads": patch
---

Fixes a gap where a workspace could implicitly bind (or explicitly claim via `uploads github link`) another org's GitHub repo the App is installed on, letting it post or deface the `uploads-sh[bot]` comment there. Claiming an unbound repo now requires the calling workspace's linked GitHub account to have push (or higher) access to that repo, verified live via the App's installation token. An unauthorized claim gets the same soft `{ posted: false, reason: "not_authorized" }` / `{ claimed: false, reason: "not_authorized" }` decline as posting to an already-bound repo — never a server error, and the CLI never falls back to `gh` for it. Repos bound before this check shipped keep working unchanged.
