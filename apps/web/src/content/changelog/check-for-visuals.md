---
title: "Check for visuals: a PR check for screenshots"
date: 2026-10-22T20:00:00Z
tags: [platform, github]
image:
  url: https://storage.uploads.sh/default/screenshots/misc/changelog/check-for-visuals-87bc37.webp
  alt: "A GitHub pull request's checks list with Check for visuals passing: 6 files attached"
---

UI changes deserve a picture, and reviewers shouldn't have to ask for one. The
[GitHub App](/docs/github-app#check) now adds a **Check for visuals** row to
every pull request in a connected repo, right next to your tests and builds.
No workflow file or Actions step needed.

Out of the box it only reports. It says what's attached, whether anything is
[held for review](/docs/ai-labels#held-uploads), and notes when a PR changes UI
files with nothing attached. Nobody is blocked. When a PR touches UI files and
has no screenshots yet, the managed comment explains how to add some,
including just dragging images into the PR.

Turn on a requirement and it works like a linter for UI changes. The check
fails until the screenshots are there, then passes on its own when they
arrive:

```yaml title=".uploads.yml"
comment:
  check:
    require: [before-after, desktop, mobile]
```

The PR comment shows that list as a checklist that ticks itself as files land.
Admins can set the same thing for every repo under **Settings → GitHub**,
along with which paths count as UI. A label like `uploads:skip-verify` skips a
PR that doesn't need screenshots.

## AI notes

Having a screenshot isn't the same as having a useful one. Turn on AI notes
and the check takes a second look at the images themselves:

```yaml title=".uploads.yml"
comment:
  check:
    ai: all
```

- **`ready-screen`** warns when an `--state after` capture looks like it's still
  loading, blank, or showing an error. Before shots are never judged.
- **`identical-before-after`** warns when the before and after are the same
  picture, usually a sign the capture ran against the wrong build.

Notes are advisory. They show in the check summary and the PR comment, never
fail the check, and add the `uploads:no-ai` label to hide them. They read the
workspace's [AI labels](/docs/ai-labels), so labels need to be on.

## Captions

Agents can now say what a shot shows. Pass `--caption` (or `caption` on MCP
`put`) and the text appears under the image in the PR comment, up to 140
characters:

```bash
uploads put ./empty.png --pr 12 --caption "Empty state after deleting the last project"
```

See [Require screenshots](/docs/require-screenshots) for every option and the
check results table.
