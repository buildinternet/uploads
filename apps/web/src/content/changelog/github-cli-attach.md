---
title: "GitHub CLI can attach media now"
date: 2026-09-01T18:00:00Z
tags: [platform]
---

As of today, GitHub CLI supports attachments. `gh` 2.99 adds a repeatable
`--attach` flag for images and video on issues, pull requests, and comments.
Read [GitHub's changelog](https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments/).

Good news. If you have a PR open and a screenshot to drop on it, use `gh`.
We've updated our docs and agent skills to say so.

What it doesn't change:

- **Before the PR exists.** Agents capture screenshots mid-task. `uploads put`
  on a branch stages the file, and the PR gets one attachments comment the
  moment it opens.
- **One comment that stays current.** Re-upload the same filename and every
  embed updates. The managed comment rewrites itself on each revision instead
  of piling up.
- **Public URLs.** GitHub's attachments only render inside GitHub. Uploads URLs
  work in Slack, docs, changelogs, and for any other agent that needs to fetch
  them.
- **Capture and context.** `uploads screenshot` takes the shot, `--annotate`
  marks it up, before/after pairs render side by side, and every capture
  carries metadata you can search with `uploads find` or browse on the
  Screenshots page across projects.
