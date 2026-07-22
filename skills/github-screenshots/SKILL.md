---
name: github-screenshots
description: >-
  Embed screenshots, images, diagrams, GIFs, and screen recordings in GitHub
  PRs and issues — or stage them ahead of a PR, collect them into one
  attachments comment, or get a durable public link to share a visual with a
  person. Use this whenever a visual needs to end up in a PR description,
  issue body, or PR/issue comment, in front of a teammate, or saved for a PR
  that doesn't exist yet. Triggers include "attach a screenshot to the PR",
  "add a before/after to the issue", "include a screenshot of …", "share a GIF
  of the flow", "record the bug and put it in the issue", "get me a link I can
  paste in Slack", "stage screenshots for the PR", "attach this when I open
  the PR", "save this for the PR", "collect the PR's media", or having just
  captured or changed something visual that a shot would make clearer — even
  mid-task, before a PR exists. Also applies when an agent has no local
  filesystem and is uploading via the hosted MCP (agents.uploads.sh). Reach
  for this instead of drag-and-drop or github.com/user-attachments (agents
  can't upload there) and instead of hand-rolling cloud-storage uploads.
  Capture the visual with whatever browser or screenshot tooling you have;
  this skill covers hosting and embedding it.
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

Two tiers, pick by whether a PR already exists:

- **Simple — a PR/issue already exists.** `uploads put shot.png --pr 123` (or
  `uploads attach shot.png`, which infers the PR from the current branch) —
  one call, stable per-PR key, embed URLs back immediately, and the managed
  comment collects that PR's media as a side effect.
- **Advanced — stage pre-PR, before there's anything to target.** `uploads
attach shot.png --branch` (see below) — no PR/issue needed yet; promotion
  and the comment happen automatically once the PR opens, **but only for a
  repo already bound to the workspace** (see the caveat below). Reach for the
  simple tier once the PR exists unless you're deliberately building up a
  staged set across a longer branch.

**Default loop: stage as you go, from the first visual milestone.** Don't wait
for a PR to exist. The moment you have something worth capturing — mid-task,
still on a branch, no PR yet — attach it right then. As of issue #403, a
**bare `uploads put`** already does this automatically whenever you're inside
a git repo on a non-default branch with no `--pr`/`--issue`/`--key`/`--ref`/
`--prefix` — it stages under the same branch-keyed path `attach --branch`
would produce, so a plain `uploads put step1-before.png --state before` is
enough. Reach for `attach --branch` explicitly when you want its extras
(uploading several files at once with shared flags, or triggering promotion/
comment sync as a side effect):

```bash
uploads put ./step1-before.png --state before
uploads put ./step2-after.png --state after   # later, same branch

# or, explicitly, e.g. to upload several at once:
uploads attach ./step1-before.png ./step2-after.png --branch --state after
```

This uploads under stable, branch-keyed paths (no PR/issue target needed, no
comment yet — there's nothing to comment on until a PR exists). Keep doing
this at each meaningful visual milestone as you work; don't batch everything
into one call at the end. On the default branch (or outside a git repo, or
with `--no-git`), `put` falls back to its ordinary dated layout — that's the
opt-out, along with any explicit `--key`/`--ref`/`--prefix`.

**Staging only auto-promotes into a bound repo — don't promise it blind.**
Auto-promotion at PR-open time (webhook or CLI-triggered, below) requires the
repo already bound to a workspace: any earlier successful attach/comment/
promote call against that repo binds it implicitly, or `uploads github link`
binds it explicitly. A repo that's never been bound and only ever staged with
`--branch` sees **no error and no comment** when the PR opens — it's a silent
no-op. If you can't confirm the repo is already bound (`uploads github link
--status`), don't tell the user the screenshot will "just show up" in the PR.
The zero-setup fallback that works regardless of binding history: once the PR
exists, run `uploads attach --promote` (or any targeted `uploads attach`
against that PR) to promote and post explicitly.

**No local filesystem?** An agent driving the hosted MCP
(`agents.uploads.sh/mcp`, no CLI, no git checkout) can still get a visual into
a PR in one call: the `put` tool takes `pr`/`issue` (+ required `repo`, since
there's no git context server-side) plus `comment: true` to post straight to
the managed attachments comment — see the **uploads-cli** skill for the exact
tool contract and honest decline reasons.

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

**Removed the wrong screenshots?** `delete` the object(s) and re-run
`comment` (or the hosted `comment` tool) to re-sync. Once the last attachment
is gone the comment is rewritten in place to a neutral empty state — it stays
on the PR (a later upload repopulates it) rather than leaving stale entries
that point at deleted files.

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
