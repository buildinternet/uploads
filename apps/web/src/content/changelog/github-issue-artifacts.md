---
title: "Issue media lands in GitHub issue artifacts"
date: 2026-11-02T22:00:00Z
tags: [platform, github, cli]
---

GitHub issues can now carry artifacts: named documents that live on the issue
itself, with their own version history, instead of somewhere down the comment
thread. They're in public preview, and `gh issue artifact` manages them.

Uploads now keeps one for you. When you run `uploads attach` on an issue (CLI
0.62.0 or newer), it writes a Markdown artifact named **uploads.sh media**
next to the managed comment, with the same screenshots in the same layout.
Attach again and it updates in place, so GitHub's history shows each
revision. When the issue has a [gallery](/docs/galleries), a second artifact,
**uploads.sh gallery**, links to it.

```bash
uploads attach ./repro.png ./after.png --issue 42
```

Your files stay on uploads.sh. The artifact embeds uploads.sh URLs and doesn't
copy bytes to GitHub, so the same images still work in Slack, docs, and for
agents that can't sign in to the repo. Video becomes a link, since artifacts
don't play `<video>`.

When to use which: `gh issue artifact create --attach` is fine for a one-off
image that only needs to render on GitHub. Reach for uploads when you want a
public URL, a recording, a private-repo capture you can share, or screenshots
that will be re-taken. The [agent skills](/docs/agents) now say the same.

Pull requests are unchanged and keep the managed comment only. Issue artifacts
are on by default. Turn them off for one command with `--no-issue-artifacts`,
per repo with `issueArtifacts: false` in [`.uploads.yml`](/docs/comment-config#issue-artifacts),
or for the workspace under **Settings → GitHub**. If GitHub rejects the write,
`attach` prints a warning and the upload and comment still go through. See
[Issue artifacts](/docs/attach-pull-request-images#issue-artifacts).
