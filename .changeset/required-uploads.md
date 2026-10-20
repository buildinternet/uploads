---
"@buildinternet/uploads": patch
---

`.uploads.yml` accepts `check.require` and `check.skipLabels`, so a repo can make the uploads.sh check fail when a PR changes UI files without the uploads it expects.
