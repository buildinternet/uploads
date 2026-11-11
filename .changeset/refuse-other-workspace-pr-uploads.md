---
"@buildinternet/uploads": patch
---

`uploads put` and `uploads attach` now stop before uploading to a PR or issue whose repo is linked to a different workspace, since those files would never appear in the PR comment. The error says to sign in to the workspace that owns the repo, or to pass `--no-comment` to upload anyway. A declined comment no longer asks whether gh is installed.
