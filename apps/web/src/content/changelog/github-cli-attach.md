---
title: "GitHub CLI can upload media now. Here's where Uploads fits."
date: 2026-09-01T18:00:00Z
tags: [platform]
---

GitHub CLI 2.99 adds a repeatable `--attach` flag to `gh issue` and `gh pr`
`create`, `edit`, and `comment`. It uploads images and video (up to 10 MB per
file, video up to 100 MB on paid plans) and rewrites local paths in your
Markdown to the hosted file. It needs push access, and GitHub Enterprise Server
isn't supported yet. Read [GitHub's changelog](https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments/) and
[the docs](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli).

Good news. If you have a PR open and one screenshot to drop on it, use `gh`.
We've updated our docs and agent skills to say so.

What it doesn't change:

- **Before the PR exists.** Agents capture screenshots mid-task. `gh --attach`
  needs an issue or PR to target. `uploads put` on a branch stages the file,
  and the PR gets one attachments comment the moment it opens.
- **One comment that stays current.** Re-upload the same filename and every
  embed updates. The managed comment rewrites itself on each revision instead
  of piling up.
- **Public URLs.** `github.com/user-attachments` links only render inside
  GitHub. Uploads URLs work in Slack, docs, changelogs, and for any other agent
  that needs to fetch them. `uploads ingest` mirrors GitHub attachments out
  when you need that.
- **Capture and context.** `uploads screenshot` takes the shot, `--annotate`
  marks it up, before/after pairs render side by side, and every capture
  carries metadata you can search with `uploads find` or browse on the
  Screenshots page across projects.
- **Everyone `gh` leaves out.** Fork contributors and read-only bots, hosted
  MCP agents with no shell, GitHub Enterprise Server, and files that aren't
  images or video.

GitHub shipping this validates the workflow. Our job is the rest of the loop.
