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

For the common case — files attached to the current branch's PR — use
`uploads attach`. It infers the PR, uploads under stable keys in parallel, and
maintains a single managed "attachments" comment. Multi-file runs keep going if
one path fails (`failures` in `--json`; exit `1` when any failed):

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

**Capturing before the PR exists?** (e.g. mid-task on a branch, no PR yet)
stage with `uploads attach --branch` instead — same upload path, but keyed to
the branch rather than a PR/issue number:

```bash
uploads attach ./shot.png --branch
```

Once you open the PR (`gh pr create`), the next `uploads attach` to it
auto-promotes those staged files into the PR's attachments (and refreshes the
comment) — no extra step needed. If that first attach has no new file to add,
run `uploads attach --promote` instead to promote and refresh without
uploading anything.

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
