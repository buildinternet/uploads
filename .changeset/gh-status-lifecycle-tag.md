---
"@buildinternet/uploads": minor
---

Branch-staged attaches now stamp `gh.status=staged`, and server-side promotion flips the staged original to `gh.status=promoted`. In-flight staged media becomes a plain equality query: `uploads find gh.status=staged` (narrow with `gh.branch=<name>` or `gh.repo=<owner/name>`).
