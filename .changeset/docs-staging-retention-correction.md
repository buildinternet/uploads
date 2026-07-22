---
"@buildinternet/uploads": patch
---

Correct the README's branch-staging retention claim: staged files are never
deleted by promotion (copy-and-keep), only skipped by promotion after 30
days.
