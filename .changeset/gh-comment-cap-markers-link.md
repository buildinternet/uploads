---
"@buildinternet/uploads": minor
---

Managed GitHub comments now cap inline images at 16 (the rest collapse into a `<details>` list) and use a per-workspace marker so two workspaces sharing a repo no longer clobber each other's comment (legacy comments are adopted and migrated automatically). Adds `uploads github link` to inspect or explicitly claim a workspace's binding to a repo.
