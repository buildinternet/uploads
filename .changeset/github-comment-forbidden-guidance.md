---
"@buildinternet/uploads": patch
---

When the uploads.sh GitHub App is installed but hasn't been granted Issues /
Pull requests write yet, `uploads comment` (and `--comment`) now prints a short
note explaining that an admin must approve the added permissions — with a link
to do it — before falling back to the local `gh` path, instead of falling back
silently.
