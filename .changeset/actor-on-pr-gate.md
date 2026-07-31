---
"@buildinternet/uploads": patch
---

Recognize the server's new `actor_not_authorized` managed-comment decline (issue #297 control 2, workspace opt-in actor-on-PR gate): like `not_authorized`, the CLI surfaces the server's guidance instead of falling back to a local `gh` post.
