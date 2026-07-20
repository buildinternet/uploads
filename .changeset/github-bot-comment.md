---
"@buildinternet/uploads": minor
---

Managed attachments comment can now be posted by the uploads.sh GitHub App as
`uploads-sh[bot]` when the App is installed on the target repo, so `--comment` /
`uploads comment` no longer require a locally authenticated `gh`. Falls back to
the existing `gh`-authored comment where the App is not installed.

Both paths now find and edit the existing managed comment on threads past 100
comments (the `gh` fallback paginates the lookup), so updating attachment media
edits the one comment in place instead of posting a duplicate.
