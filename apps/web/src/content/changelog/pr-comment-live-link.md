---
title: "PR comments link to the pull request's live link"
date: 2026-10-04
tags: [platform, web, cli]
---

The managed PR comment now opens with one line, such as `12 files · View all on uploads.sh →`. It
links to the pull request's live link at `/c/<id>`: every file tagged with the pull request, newest
first, on one public page.

Each tagged file in the comment links to its own page in that live link, including files older than
the newest 50. The live link page now pages past 50 with **Older files**.

The comment posted through your local `gh` shows the same line and links. Turn them off with
`linkToFilePage: false` in [`.uploads.yml`](/docs/comment-config). See [Live links](/docs/feeds).
