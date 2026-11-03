---
title: "Images dragged into a PR land in Uploads"
date: 2026-10-22T18:00:00Z
tags: [platform, github]
---

Not everyone on a pull request has the uploads CLI. A reviewer drags a
screenshot into a comment, a contributor pastes one into the description, or an
agent attaches one with `gh --attach`. With the [GitHub App](/docs/github-app#ingest)
installed, those images and videos are now imported into your workspace and
join the managed attachments comment, next to the files your agents uploaded.

That makes the comment the full set of visuals for the PR. One place to look,
in one layout, whoever added them and however they did it. Imported files also
count toward [Check for visuals](/docs/require-screenshots#what-counts), so a
contributor without uploads.sh is never stuck on a required check.

Private repos work too. GitHub only serves a private repo's attachments to
people who can see the repo, so the App reads the signed links GitHub renders
on the pull request and imports from those.

A few details:

- **Create and edit.** Import runs when a description or comment is posted and
  again when it's edited. Remove an image from the text and it leaves the
  comment on the next sync.
- **They outlive GitHub's copy.** Imported files carry the same `gh.*` metadata
  as CLI uploads, so they show up in search, live links, and the Screenshots
  page.
- **Noise stays out.** Attachments from `[bot]` accounts and images under 200
  pixels on a side (badges, emoji) are skipped.
- **Backfill.** Older PRs pick up their images on the next edit, or right away
  with `uploads ingest --pr 123`.

Import is on by default for linked repos. Turn it off per workspace under
**Settings → GitHub**, or per repo with `ingestGithubAttachments: false` in
[`.uploads.yml`](/docs/comment-config).
