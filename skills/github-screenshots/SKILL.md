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

## Step 1 — Get the visual (any tool)

Capture is tool-agnostic. Use whatever this environment has and save a local
file:

- The agent harness's own browser tools (screenshot the preview pane).
- A Playwright/browser MCP, `agent-browser`, or similar automation.
- An OS screenshot or screen recording the user already made.
- Any existing image, GIF, or diagram file.

GIFs and video upload as-is — the client-side optimizer only rewrites still
images (PNG/JPEG → WebP). No special flags needed for motion.

## Step 2 — Host and embed

For the common case — files attached to the current branch's PR — use
`uploads attach`. It infers the PR, uploads under stable keys, and maintains
a single managed "attachments" comment:

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
