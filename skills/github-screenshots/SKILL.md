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
  for this instead of drag-and-drop or hand-rolling cloud-storage uploads.
  GitHub CLI 2.99+ can attach a single image to an existing PR or issue with
  `gh … --attach`; this skill says when that is enough and when it is not.
  Capture the visual with whatever browser or screenshot tooling you have;
  this skill covers hosting and embedding it.
---

# Screenshots and recordings in GitHub PRs and issues

## Why this exists

GitHub's native image hosting (`github.com/user-attachments/…`) is reachable
from a browser and, since GitHub CLI 2.99 (September 2026), from
`gh issue|pr create|edit|comment --attach <file>`. There is still no public REST
endpoint (the CLI uses an undocumented upload host), the upload needs push access, and the hosted file is private to
GitHub. Any other image URL in a PR/issue body written with `gh … --body-file`
must already point at something publicly hosted. The **`uploads` CLI** and the
hosted MCP at `https://agents.uploads.sh/mcp` both host the file on uploads.sh
and return a stable public URL plus ready-to-paste markdown.

## When `gh --attach` is enough

Use plain `gh pr comment --attach ./shot.png` (or `create`/`edit`) when ALL
of these hold:

- `gh --version` is 2.99 or newer and you have push access to the repo.
- The PR or issue already exists, or you are creating it in the same command.
- The file is an image or video under 10 MB (video up to 100 MB on paid plans).
  `gh --attach` takes media only.
- Nobody needs the link outside GitHub. `user-attachments` URLs do not render
  in Slack, docs, or other tools, and other agents cannot fetch them.

Use uploads.sh when any of these are true instead:

- The artifact is not media: a Lighthouse or test report, a log, JSON, a PDF, or
  a zip. `gh --attach` does not take those; `uploads put` does, and the managed
  comment links them.
- The PR does not exist yet. Stage on the branch with `uploads put`; the
  attachments comment appears when the PR opens.
- The shot will be re-taken. Same filename, same URL, and the managed comment
  updates in place instead of piling up.
- The capture needs metadata (`--meta`), later retrieval (`uploads find`), or
  the Screenshots view across projects.
- The URL must work outside GitHub.
- You are on the hosted MCP with no shell, lack push access, or the repo is on
  GitHub Enterprise Server.

Do not mix the two on one PR: pick one so the comment history stays readable.
Media attached with `gh` is still indexed: the GitHub App imports attachments
from PR and issue text into the workspace. To pull an existing
`user-attachments` image out to a public URL by hand, use `uploads ingest`.

## Which surface

Pick one transport and stay on it. This skill is the workflow. The
**uploads-cli** skill owns flags and MCP tool contracts.

| You have                                           | Use                                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No shell (ChatGPT, or any host without a checkout) | Hosted MCP `put` with (`contentBase64` + `filename`, or `contentUrl`) + `repo` + (`pr` or `branch`). Filename is optional with `contentUrl` when the URL path has a leaf. Embed the returned `markdown` / `embedUrl`. Never imply you can run `uploads attach ./shot.png`. |
| A checkout and the `uploads` binary                | The CLI examples below. Git can fill `repo` / `branch`.                                                                                                                                                                                                                    |
| A `localhost` page or a selector annotate          | CLI only (`uploads screenshot --via local`). Remote render cannot reach your machine.                                                                                                                                                                                      |
| Neither MCP nor the CLI                            | Stop and say so. Do not treat `npm install -g` as the ChatGPT path.                                                                                                                                                                                                        |

On the hosted MCP there is no `attach` tool and no git defaults. Stage with
`put` + `branch` + `repo`. Once the PR exists, `promote` with `repo` + `pr` +
`branch`, or `put` with `pr` + `repo` (optional `branch` also promotes). The
managed comment is bot-only on that server.

## Step 1 — Capture the visual

Skip this step if the visual is already in context (a ChatGPT attachment, a
file the host already holds). Go straight to hosted MCP `put`.

**Prefer `uploads screenshot <url|file.html>`** — it captures **and** hosts in
one step (drives a local Chrome, or falls back to a server-side render), so you
skip a separate host call. It takes `--viewport WxH@Nx`, `--wait`, `--selector`,
`--full-page`, and `--out <file>` (to also save the PNG).

Capturing your **own dev server**? No manual DOM surgery needed:

- Known framework dev toolbars (Astro/Next/Nuxt/Vite) are hidden automatically
  — opt out with `--no-hide-dev-tools`.
- `--reduced-motion` settles animations.
- `--hide <selector>` hides any other overlay (repeatable).
- `--eval <js>` / `--init-script <file>` (local backend) are the escape hatch
  to dismiss a banner or freeze a specific animation.

Capturing a **clicked/selected state of a React/Next (or other hydrating) app**?
A synthetic `el.click()` in `--eval` fires before the framework hydrates — the
element is in the SSR HTML but no handler is attached yet, so it silently does
nothing. Gate on the app's own "interactive" signal with `--wait-for <js>`
(local backend), which polls that expression until truthy before `--eval` runs:

```bash
uploads screenshot http://localhost:3000 --via local \
  --wait-for 'document.querySelector("[data-hydrated]")' \
  --eval 'document.querySelector(".tab-settings").click()' --out settings.png
```

```bash
uploads screenshot http://localhost:4321 --viewport 1520x960@1x --out home.png --reduced-motion
uploads screenshot https://uploads.sh --selector main --dark
```

`--out` also drops a `<file>.uploads.json` sidecar next to the PNG — that's a
working file for a later `put`/`attach` to pick metadata back up from, not
something to commit, so `.gitignore` it (`*.uploads.json`) or delete it once
you're done attaching.

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
- **Advanced — stage pre-PR, before there's anything to target.** `uploads put shot.png` on a branch (see below) — no PR/issue needed yet; promotion
  and the comment happen automatically once the PR opens, **but only for a
  repo already bound to the workspace** (see the caveat below). Reach for the
  simple tier once the PR exists unless you're deliberately building up a
  staged set across a longer branch.

**Default loop: stage as you go, from the first visual milestone.** Don't wait
for a PR to exist — the moment you have something worth capturing, mid-task on a
branch, attach it right then.

Two commands stage automatically, no extra flag needed:

- A **bare `uploads put`**, whenever you're inside a git repo on a non-default
  branch with no `--pr`/`--issue`/`--key`/`--ref`/`--prefix`. It stages under
  the same branch-keyed path `attach --branch` would produce.
- **`uploads screenshot`** with no `--pr`/`--issue`/`--branch` target.
  Capturing straight from a URL carries every derived fact — path, url, env,
  viewport, plus `--state` — through to the PR once it opens.

Reach for `attach --branch` explicitly only when you want its extras: uploading
several files at once with shared flags, or triggering promotion/comment sync as
a side effect.

Staging keys embed the branch name. Renaming it is followed automatically the
next time you run any `uploads` staging or promote command on that branch — if
the PR opens before that happens, recover the stranded files with
`uploads attach --pr <n> --from-branch <old-branch-name>` (see uploads-cli).

```bash
uploads screenshot http://localhost:4321/settings --out step1-before.png --state before
uploads screenshot http://localhost:4321/settings --out step2-after.png --state after

# or, capturing an existing local file instead of a live URL:
uploads put ./step1-before.png --meta path=/settings --state before

# or, explicitly, e.g. to upload several at once:
uploads attach ./step1-before.png ./step2-after.png --branch --state after
```

This uploads under stable, branch-keyed paths (no PR/issue target needed, no
comment yet — there's nothing to comment on until a PR exists). Keep doing
this at each meaningful visual milestone as you work; don't batch everything
into one call at the end. On the default branch (or outside a git repo, or
with `--no-git`), `put`/`screenshot` fall back to their ordinary dated
layout — that's the opt-out, along with any explicit `--key`/`--ref`/
`--prefix`/`--destination`.

**Staging only auto-promotes into a bound repo — don't promise it blind.**
Auto-promotion at PR-open time (webhook or CLI-triggered, below) needs the repo
already bound to a workspace. Binding happens two ways:

- Implicitly, from any earlier successful attach/comment/promote call against
  that repo.
- Explicitly, via `uploads github link`.

A repo that's never been bound and only ever staged with `--branch` sees **no
error and no comment** when the PR opens — a silent no-op. So if you can't
confirm the repo is bound (`uploads github link --status`), don't tell the user
the screenshot will "just show up." The fallback that works regardless of
binding history: once the PR exists, run `uploads attach --promote` (or any
targeted `uploads attach` against that PR) to promote and post explicitly.

**Pass `--state before`/`--state after` and `--meta path=/route` as a habit —
both, every time.** They're the two highest-value queryable tags, and the two a
tool can't recover later:

- `--state` before/after is the whole point of most PR screenshots, and nothing
  can infer it from the image.
- `path` is just as easy to forget, except on `uploads screenshot`, which
  derives it from the captured URL. A `put`/`attach` of an existing file has no
  URL to derive it from.

Both cost one flag now and make `uploads find state=after` or `uploads find
path=/settings` work months later, when the filenames mean nothing to anyone.

**For a same-URL before/after pair, `uploads screenshot` is the straightforward
path.** Its object name derives from the captured URL, and `--state` folds into
that name — `localhost-docs-mcp.webp` becomes `-before.webp`/`-after.webp`. So
capturing the same URL twice with different states lands two distinct objects
instead of one overwriting the other. Pass an explicit `--key` when you need a
specific object name. A `put` of an existing file has no URL to derive a stem
from, so keep its before/after distinct with separate filenames or `--key`:

```bash
uploads screenshot https://app.example/settings --pr 123 --state before
uploads screenshot https://app.example/settings --pr 123 --state after
uploads put ./after.png --pr 123 --meta path=/settings --state after
```

(`--state` also takes `empty`, `error`, and `loading`.) When an image lands with
no `path` meta, `attach`/`put --pr`/`put --issue` print `tip: add --meta
path=/route so this shot is findable by page` on stderr (and a JSON `hint`
field) — don't ignore it. Viewport is derived for you on `screenshot`. See the
**uploads-cli** skill for the full canonical vocabulary.

**The PR comment assembles itself — you don't drive that step.** Once the PR
opens (whether via `gh pr create` or the GitHub UI), every branch-staged file
gets promoted into that PR's attachments and the managed comment is created
automatically. Files you never mention in the description still show up there.
The comment is identified by a hidden HTML comment at the top:
`<!-- uploads.sh:attachments ws=<workspace> -->`. Bot posts are from
`uploads-sh[bot]`; the local-`gh` fallback uses the same marker.

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

For a URL you'll hard-code in a PR/issue **body** (re-uploads overwrite in
place, URL never changes). Putting an image in the description works — that's
the right place for a visual that belongs in the write-up (a before/after in
"what it looks like"). You don't have to. Wait until the PR exists and use
`--pr`, so the body gets the stable `pull/<n>/` key from the start. Don't
paste a branch-staged URL into the description and later rewrite it to
`pull/<n>/` just to "correct" it.

```bash
uploads put ./after.png --pr 123 --alt "Dashboard after" --width 700
```

For a durable public link to share anywhere (Slack, docs, a teammate):

```bash
uploads put ./demo.gif --format url
```

When you do embed, use the returned **markdown** (or `embedUrl`) — the
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

- No shell? Use the hosted MCP. Do not install the CLI.
- CLI missing on a machine with a shell? `npm install --global @buildinternet/uploads`
- Not authenticated on the CLI? `uploads login` (one-time, opens a browser),
  then `uploads doctor` to verify. Hosted MCP uses OAuth on first tool call.
- Everything deeper — flags, key layouts, MCP tool contracts, metadata and
  search, galleries, config defaults, output formats, exit codes — lives in
  the **uploads-cli** skill and `uploads <command> --help`.

## Cautions

- **Uploads are public and effectively permanent** until deleted. GitHub repo
  visibility is not an access control, and `gh/<owner>/<repo>/pull/<num>/…`
  keys are predictable. Never upload secrets, tokens, or customer PII —
  crop/redact first.
- **Private repos get an unguessable URL automatically.** When the uploads
  GitHub App can see a target repo is private, attachments key under
  `gh/private/<id>/…` instead — no flag needed. The id is durable, not
  access-controlled: anyone who gets the URL can read it until you rotate it
  (`uploads github rotate-prefix`). See **docs/private-attachments.md** for
  the full model.

## Need to point at something in the screenshot?

Boxes, arrows, labels, freeform strokes, and redaction (solid for secrets
caught in a capture — blurred text can be recoverable) get baked onto a
screenshot with `uploads
screenshot --annotate` or `uploads annotate` — see the **annotate-screenshots**
skill for the spec format and workflow, then come back here to attach.
