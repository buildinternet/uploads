---
"@buildinternet/uploads": minor
"@uploads/plugin": patch
---

`uploads attach` on an issue keeps one Markdown GitHub issue artifact, and a gallery link when the issue has a gallery, in sync with the managed comment. This is on unless `--no-issue-artifacts` is passed, the repo sets `comment.issueArtifacts: false`, or the workspace turns it off under Settings → GitHub. Pull requests are unchanged. The agent skills describe when `gh issue artifact create --attach` is enough and when to use uploads.
