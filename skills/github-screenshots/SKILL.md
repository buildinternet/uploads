---
name: github-screenshots
description: >-
  Embed screenshots, images, diagrams, GIFs, and screen recordings in GitHub
  PRs and issues — or get a durable public link to share a visual with a
  person. Use this whenever a visual needs to end up in a PR description,
  issue body, or PR/issue comment, or in front of a teammate. Triggers include
  "attach a screenshot to the PR", "add a before/after to the issue", "include
  a screenshot of …", "share a GIF of the flow", "record the bug and put it in
  the issue", "get me a link I can paste in Slack", or having just captured or
  changed something visual that a shot would make clearer. Reach for this
  instead of drag-and-drop or github.com/user-attachments (agents can't upload
  there) and instead of hand-rolling cloud-storage uploads. Capture the visual
  with whatever browser or screenshot tooling you have; this skill covers
  hosting and embedding it.
---

# Screenshots and recordings in GitHub PRs and issues

## Why this exists

GitHub's native image hosting (`github.com/user-attachments/…`) only works
from an authenticated browser session — there is no `gh` CLI or REST endpoint
for it. Any image URL in a PR/issue body written with `gh … --body-file` must
already point at something publicly hosted. The **`uploads` CLI** provides
that: it hosts the file on uploads.sh and returns a stable public URL plus
ready-to-paste markdown.

## Step 1 — Capture the visual

**Prefer `uploads screenshot <url|file.html>`** — it captures **and** hosts in
one step (drives a local Chrome, or falls back to a server-side render), so you
skip a separate host call. It takes `--viewport WxH@Nx`, `--wait`, `--selector`,
`--full-page`, and `--out <file>` (to also save the PNG).

Capturing your **own dev server**? It hides known framework dev toolbars
(Astro/Next/Nuxt/Vite) automatically (opt out with `--no-hide-dev-tools`) and
takes `--reduced-motion` to settle animations — no manual DOM surgery. Use
`--hide <selector>` for any other overlay (repeatable), and `--eval <js>` /
`--init-script <file>` (local backend) as an escape hatch to dismiss a banner or
freeze a specific animation.

```bash
uploads screenshot http://localhost:4321 --viewport 1520x960@1x --out home.png --reduced-motion
uploads screenshot https://uploads.sh --selector main --dark
```

Only reach for your harness's browser tools / Playwright / an existing file when
`uploads screenshot` can't reach the target (e.g. a flow that needs auth or
interaction first). GIFs and video: capture with any tool and upload as-is — the
optimizer only rewrites still images (PNG/JPEG → WebP).

## Step 2 — Host and embed

**Default loop: stage as you go, from the first visual milestone.** Don't wait
for a PR to exist. The moment you have something worth capturing — mid-task,
still on a branch, no PR yet — attach it right then with `uploads attach
--branch`:

```bash
uploads attach ./step1-before.png --branch --state before
uploads attach ./step2-after.png --branch --state after   # later, same branch
```

This uploads under stable, branch-keyed paths (no PR/issue target needed, no
comment yet — there's nothing to comment on until a PR exists). Keep doing
this at each meaningful visual milestone as you work; don't batch everything
into one attach at the end.

**Pass `--state before`/`--state after` as a habit.** Before/after is the whole
point of most PR screenshots, and it's the one thing no tool can infer from the
image. It costs a flag now and makes `uploads find state=after` work months
later, when the filenames mean nothing to anyone. (`--state` also takes `empty`,
`error`, and `loading`.) Route and viewport are derived for you — see the
**uploads-cli** skill for the full canonical vocabulary.

**The PR comment assembles itself — you don't drive that step.** Once the PR
opens (whether via `gh pr create` or the GitHub UI), every branch-staged file
gets promoted into that PR's attachments and the managed "📎 Attachments"
comment is created automatically:

- **With the uploads-sh GitHub App installed** on the repo, a webhook does
  this the moment the PR opens, reopens, or gets a new commit — no CLI call
  required at all.
- **Without the App**, the next `uploads attach` you run against that PR
  triggers the same promotion + comment refresh as a side effect. If you have
  nothing new to add right after opening the PR, run `uploads attach
--promote` (zero file arguments) to promote and refresh explicitly — it
  exits `0` even if nothing was staged. Skip auto-promotion on a given call
  with `--no-promote`.

**"PR already exists" is just the simple case of the same command** — same
`uploads attach`, just pointed at a PR/issue number instead of a branch, and
the comment updates immediately since there's already something to comment
on:

```bash
uploads attach ./before.png ./after.png
uploads attach ./flow.gif --issue 45 --repo myorg/myapp
uploads attach ./shot.png --no-comment      # stable URLs only, no comment
```

For a URL you'll hard-code in a PR/issue body (re-uploads overwrite in place,
URL never changes):

```bash
uploads put ./after.png --pr 123 --alt "Dashboard after" --width 700
```

For a durable public link to share anywhere (Slack, docs, a teammate):

```bash
uploads put ./demo.gif --format url
```

Always embed the returned **markdown** (or `embedUrl`) in GitHub — it uses the
no-cache host so overwrites propagate. Don't hand-build storage URLs.

**Comment briefly disappeared? Don't panic-repost.** If the App is installed
and subscribed to the `issue_comment` event, a deleted or edited-out managed
comment self-heals automatically on the next webhook delivery — no need to
run `comment`/`attach` again just to bring it back.

**Bot comment not showing up at all?** The managed comment needs a
repo↔workspace binding (normally created implicitly by the first
comment/promote call, or by installing the GitHub App). If a comment you
expected doesn't appear, check the binding first:

```bash
uploads github link --status
```

That's read-only and shows the current binding (or that the repo is
unbound) without claiming anything. If the CLI reports `not_authorized`
instead, the repo is already bound to a _different_ workspace — it
won't fall back to posting via your own `gh` auth in that case. The fix is
`uploads github unlink --repo owner/name` from the owning workspace, or
asking an operator to reassign the binding; switching to the workspace that
already owns it also works.

**Curate, don't dump.** The comment inlines up to **16 images**; anything past
that collapses into a `<details>` overflow list. Name and pick shots
meaningfully (`before.png`/`after.png`, not `capture-1`..`capture-40`) rather
than attaching every incidental screenshot from a long session — a curated
handful of milestones reads better than a dumped folder.

## Step 3 — Embed well

- **Meaningful alt text**, always (`--alt`).
- **Constrain width** on large shots with `--width` (emits sized `<img>`).
- **Before/after** reads best side by side:

  ```markdown
  | Before                               | After                               |
  | ------------------------------------ | ----------------------------------- |
  | <img width="380" src="…/before.png"> | <img width="380" src="…/after.png"> |
  ```

- **Motion:** GitHub markdown won't autoplay MP4 URLs — prefer a GIF, or a
  still image that links to the video URL.
- Write bodies to a file and use `gh pr edit --body-file` / `gh issue comment
--body-file` rather than inline HEREDOCs.

## Setup and escalation

- CLI missing? `npm install --global @buildinternet/uploads`
- Not authenticated? `uploads login` (one-time, opens a browser), then
  `uploads doctor` to verify.
- Everything deeper — flags, key layouts, metadata and search, galleries,
  config defaults, output formats, exit codes — lives in the **uploads-cli**
  skill and `uploads <command> --help`.

## Cautions

- **Uploads are public and effectively permanent** until deleted. GitHub repo
  visibility is not an access control, and `gh/<owner>/<repo>/pull/<num>/…`
  keys are predictable. Never upload secrets, tokens, or customer PII —
  crop/redact first.
