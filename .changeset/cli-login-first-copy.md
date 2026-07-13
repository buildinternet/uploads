---
"@buildinternet/uploads": patch
---

`uploads setup` and `uploads login --help` now lead with `uploads login` (device authorization) as the recommended way to sign in. Enrollment codes (`--code` / `--code-stdin`) are still supported and are now clearly described as a fallback for pre-existing invites. No behavior changes.
