---
"@buildinternet/uploads": minor
---

Managed attachments comment can now be posted by the uploads.sh GitHub App as
`uploads-sh[bot]` when the App is installed on the target repo, so `--comment` /
`uploads comment` no longer require a locally authenticated `gh`. Falls back to
the existing `gh`-authored comment where the App is not installed.
