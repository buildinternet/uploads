---
description: Host a screenshot, GIF, or file on uploads.sh and attach it to a GitHub PR/issue (or just get a public URL)
argument-hint: <file-or-description> [PR#/issue#]
---

# /uploads:attach

Host a screenshot, GIF, recording, or file on [uploads.sh](https://uploads.sh)
and embed it in a GitHub PR or issue — or just get back a public URL.

## Usage

```
/uploads:attach <file-or-description> [target]
```

- **file-or-description**: A local path to host, or a description of what to
  capture/attach (e.g. "the failing test output", "before/after of the header").
- **target**: An optional GitHub PR or issue (e.g. `#142`) to embed the image in.

## Examples

```
/uploads:attach ./out/report.png
/uploads:attach screenshot of the new homepage, attach to #198
/uploads:attach before/after GIF of the footer refresh, add to PR #206
/uploads:attach give me a public link for docs/diagram.svg
```

## How it works

1. For anything visual that belongs in a **GitHub PR or issue**, follow the
   `uploads:github-screenshots` skill — it captures (or takes a given file),
   hosts it on uploads.sh with a stable per-PR/issue key, and embeds the URL in
   the description, body, or a comment.
2. For a plain **public link** to an existing file, or for exact CLI flags
   (keys, galleries, metadata, `put`/`attach`/`screenshot`), follow the
   `uploads:uploads-cli` skill.
3. Hosting and lookups can also go through the bundled **uploads MCP server**
   (`put`, `list`, `attach`, galleries), which runs the local `uploads mcp` and
   reuses your `uploads login` session — see this plugin's README for setup.
