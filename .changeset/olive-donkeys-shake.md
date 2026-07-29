---
"@buildinternet/uploads": patch
---

Collapse a managed attachments comment that lost a create race. Find-or-create
was not atomic, so a second writer could create its own comment inside the same
window and leave a permanent stale orphan on the PR. After creating, the comment
is now verified once: the oldest marker comment wins, the current body is folded
into it, and the duplicate is deleted.
