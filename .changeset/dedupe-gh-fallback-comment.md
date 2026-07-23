---
"@buildinternet/uploads": patch
---

The local-`gh` fallback for the managed attachments comment (used when the GitHub App bot path is unavailable or unauthorized) now collapses duplicate marker comments the same way the bot path does: it collects every comment carrying the workspace's exact namespaced marker, patches the oldest, and best-effort deletes the rest, swallowing delete failures. Previously this path only ever patched the first match it found, so a duplicate left by a concurrent-create race (two `uploads attach` runs racing before either found an existing comment) never healed. Legacy unnamespaced marker comments are still adopt-only and are never deleted.
