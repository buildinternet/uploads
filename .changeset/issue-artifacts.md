---
"@buildinternet/uploads": minor
"@uploads/plugin": patch
---

`uploads attach` on an issue can keep one Markdown GitHub issue artifact, and a gallery link when the issue has a gallery, in sync with the managed comment. The behavior is off unless `.uploads.yml` sets `comment.issueArtifacts: true` or the command passes `--issue-artifacts`. Pull requests are unchanged. The agent skills describe when `gh issue artifact create --attach` is enough and when to use uploads.
