---
name: uploads-cli
description: >-
  Host a file on uploads.sh (Cloudflare R2 behind an API) and get a stable, public
  URL — then embed it in a GitHub PR or issue. Use this whenever you want to put a
  screenshot, diagram, before/after image, GIF, or any binary into a PR description,
  issue body, or PR/issue comment, or whenever you just need a durable public link to
  a local file. Triggers include "upload this", "host this image", "attach a
  screenshot to the PR", "add a before/after to the issue", "give me a public URL for
  this file", "put this in the PR comment", or having just built/changed something
  visual that a shot would make clearer. Reach for this instead of drag-and-drop or
  the GitHub API (an agent can't upload to github.com/user-attachments) and instead of
  hand-rolling R2/SigV4 uploads. This is the API-backed successor to the
  github-screenshots skill's bundled R2 scripts.
---

# Uploading files to uploads.sh and embedding in GitHub

## What this does and why

GitHub's native image hosting (`github.com/user-attachments/…`) is only reachable
through an authenticated **browser session** — there is no `gh` CLI or REST endpoint
for it. So any image URL you put in a PR/issue body written with `gh … --body-file`
must already point at something publicly hosted.

This skill solves that with the **`uploads` CLI**: it PUTs a local file to the
uploads.sh API (Cloudflare R2 behind a Hono Worker), which returns a stable
`https://storage.uploads.sh/<key>` URL you can drop straight into markdown. No
browser, no repo bloat, no SigV4 by hand. For PRs and issues it can also create and
maintain a single "attachments" comment for you via your local `gh` auth.

For the common case, use `uploads attach <file...>`. It infers the current branch's PR,
uploads every file under stable attachment keys, and maintains the comment by default:

```bash
uploads attach ./before.png ./after.png
uploads attach ./shot.png --issue 45 --repo buildinternet/uploads
```

Pass `--no-comment` when only stable URLs are wanted. Use `put` for lower-level naming
and output control.

The killer feature for GitHub: `--pr`/`--issue` produce **hash-free, stable keys**
(`gh/<owner>/<repo>/pull/<num>/<name>`), so re-uploading the same filename overwrites
in place and the URL never changes — you can update a screenshot after review and the
PR keeps rendering the new one (the API sets `Cache-Control: max-age=60`, so edits
propagate within ~a minute).

## Prerequisites

- **Node.js ≥ 22.**
- **The CLI.** Install globally for repeated agent use, or run a pinned version:
  ```bash
  npm install --global @buildinternet/uploads
  npx @buildinternet/uploads@0.1.0 --help
  ```
  Inside this repo, run it via pnpm — the root `uploads` script builds
  the package first, so it always reflects local source:
  ```bash
  pnpm uploads <command> [args]        # from the repo root
  ```
  If `@buildinternet/uploads` is installed/linked elsewhere, the binary is just
  `uploads`. Every example below uses `uploads …`; prefix with `pnpm ` in-repo.
- **A configured token** (one-time — see below). Check with `uploads doctor`.
- **`gh` CLI, authenticated** — only for the `--comment` / `comment` features that
  write to a PR/issue. Plain uploads don't need it.

## One-time setup

Config lives in a shared, user-owned file so it survives skill reinstalls and is
shared with `github-screenshots` and other buildinternet skills (each reads only its
own prefixed keys):

```
~/.config/buildinternet/config        # or $XDG_CONFIG_HOME/buildinternet/config
```

Resolution is **per key, first match wins**: CLI flags (`--api-url`, `--token`,
`--workspace`) → `UPLOADS_*` environment vars → `--env-file <path>` →
`$BUILDINTERNET_CONFIG` → the shared config file. For a one-off against a different
API or workspace, just export the var or pass `--env-file`.

The fastest path is enrollment. Ask an uploads.sh administrator for a short-lived
enrollment code, then run:

```bash
uploads login          # prompts without echoing the code, saves config, runs doctor
```

For a non-interactive agent, pass the short-lived code through the environment rather
than a process-list-visible command argument:

```bash
UPLOADS_ENROLLMENT_CODE=upe_<workspace>_… uploads login
```

Routine agents never need `ADMIN_TOKEN`. Enrollment codes expire after 10 minutes and
can be redeemed once. The resulting token defaults to 90 days and `files:read` plus
`files:write`; it cannot delete files unless an administrator explicitly grants
`files:delete`. Verify or inspect setup at any time:

```bash
uploads setup                                  # shows effective configuration
uploads doctor                                 # health + auth + workspace checks
```

Tokens encode their workspace (`up_<workspace>_…`), so the CLI infers `--workspace`
when you don't set it. Legacy administrator-minted tokens remain valid. See "Config
commands" for setting put defaults
(default repo, prefix, image width) once instead of per-command.

## Core workflow: `uploads put`

Upload a file and get back a URL plus ready-to-paste markdown:

```bash
uploads put ./shot.png --repo myorg/myapp --ref 1722 --alt "New live feed cards" --width 700
```

Human output goes to stderr; the URL and markdown to stdout, so you can pipe or
capture them. Use `-` as the file to read from stdin.

Key options (`uploads put --help` for all):

| Flag                                  | Purpose                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `--alt <text>`                        | Alt text for the markdown (default: filename). Always write meaningful alt text. |
| `--width <px>`                        | Emit sized `<img width=…>` HTML instead of `![]()` (markdown can't size images). |
| `--repo <owner/repo>`                 | Repo segment of the auto key (default: git remote, or `UPLOADS_DEFAULT_REPO`).   |
| `--ref <id>`                          | PR/issue/branch/date segment (default: today, or `UPLOADS_DEFAULT_REF`).         |
| `--prefix <path>`                     | Key prefix (default: `screenshots`, or `UPLOADS_DEFAULT_PREFIX`).                |
| `--key <key>`                         | Set the object key explicitly; skips the auto-naming below.                      |
| `--content-type <mime>`               | Override the content type (else inferred from extension).                        |
| `--no-git`                            | Don't derive `--repo` from the git remote (or `UPLOADS_NO_GIT=1`).               |
| `--format human\|url\|markdown\|json` | Control stdout. `--json` (global) forces json.                                   |
| `-w, --workspace <name>`              | Override workspace (wins over env and token inference).                          |

**How keys work** — three paths, no extra naming modes:

| Intent                                | Command                                    |
| ------------------------------------- | ------------------------------------------ |
| Just upload it, give me a URL         | `uploads put ./file.png`                   |
| Stable GitHub embed I might re-upload | `uploads put ./file.png --pr <num>`        |
| I know exactly where it goes          | `uploads put ./file.png --key my/path.png` |

Default `put` is the fast path; you don't need `--key`, `--prefix`, or `--repo`. Without
`--key`, keys look like
`<prefix>/<repo-name>/<ref-or-date>/<basename>-<shorthash>.<ext>` — the short hash
prevents collisions without random names or a separate "preserve name" flag. Override
with `--key` only when you have a reason.

**Output formats** — pick what you'll consume:

```bash
uploads put ./shot.png --format url        # just the URL, for scripting
uploads put ./shot.png --format markdown   # just the ![]()/<img> snippet
uploads put ./shot.png --json              # {workspace,key,url,size,markdown}
```

## Embedding in a GitHub PR or issue

Two ways, depending on whether you want a durable URL, a managed comment, or both.

### Option A — stable attachment URL (`--pr` / `--issue`)

Gives the file a **hash-free, stable key** so re-uploads overwrite in place and the
URL is safe to hard-code in a PR body you'll edit later:

```bash
uploads put ./after.png --pr 123 --alt "Dashboard after"
# key: gh/<owner>/<repo>/pull/123/after.png  → stable public URL
```

`--issue <num>` does the same under `.../issues/<num>/`. The `<owner>/<repo>` comes
from `--repo` or the git remote. `--pr`/`--issue` can't be combined with `--key`,
`--ref`, or `--prefix` (the key layout is fixed), and are mutually exclusive.

Then reference the URL in the PR/issue markdown you write with `gh`:

```markdown
<img width="700" alt="Dashboard after" src="https://storage.uploads.sh/gh/myorg/myapp/pull/123/after.png">
```

### Option B — managed attachments comment (`--comment` / `comment`)

Add `--comment` to upload **and** create/update a single comment on the PR/issue that
lists every file uploaded for it. It finds its own prior comment via a hidden marker
and edits it in place — it never touches the description or other comments:

```bash
uploads put ./after.png --pr 123 --comment
```

The upload is authoritative; the comment is best-effort — if `gh` is missing or
unauthenticated, the upload still succeeds and you get a warning. To (re)sync the
comment without uploading anything (e.g. after several `--pr` uploads), use the
standalone command:

```bash
uploads comment --pr 123
uploads comment --issue 45 --repo buildinternet/uploads
```

### Embedding best practices

- **Meaningful alt text**, always — it's what readers with images off and search see.
- **Constrain width** on large shots with `--width` so they don't dominate the page.
- **Before/after reads best side by side** in a table:
  ```markdown
  | Before                               | After                               |
  | ------------------------------------ | ----------------------------------- |
  | <img width="380" src="…/before.png"> | <img width="380" src="…/after.png"> |
  ```
- Prefer writing the body to a file and using `gh pr edit --body-file` / `gh issue
comment --body-file` over inline HEREDOCs.
- The host is agnostic — the same URLs work in issues, PR comments, discussions, and
  plain markdown docs.

## Managing uploads

```bash
uploads list --prefix screenshots/        # list objects (key + url)
uploads list --pr 123                      # everything attached to a PR
uploads list --all --json                  # paginate fully, machine-readable
uploads delete <key>                       # remove an object
uploads delete <key> --dry-run             # show what would be deleted
uploads health                             # API liveness (no auth)
uploads doctor                             # health + auth + workspace alignment
```

`doctor` is the first thing to run when something's off — it distinguishes a down
API, a bad/missing token, a workspace/token mismatch, and a local-vs-prod URL
mismatch, and prints targeted hints.

## Config commands

Set shared defaults once instead of passing flags every time:

```bash
uploads config show                              # effective settings (token redacted)
uploads config path                              # resolved config file path
uploads config set UPLOADS_DEFAULT_REPO myorg/myapp
uploads config set UPLOADS_DEFAULT_WIDTH 700
uploads config init --api-url http://localhost:8787 --workspace default --token up_default_…
```

Recognized keys: `UPLOADS_API_URL`, `UPLOADS_WORKSPACE`, `UPLOADS_TOKEN`,
`UPLOADS_DEFAULT_PREFIX`, `UPLOADS_DEFAULT_REPO`, `UPLOADS_DEFAULT_REF`,
`UPLOADS_DEFAULT_WIDTH`, `UPLOADS_NO_GIT`.

## Local development

Point at a locally running API (`pnpm dev` serves it on `:8787`). Tokens minted with
`workspace:add --local` only work against localhost; prod tokens need
`UPLOADS_API_URL=https://api.uploads.sh`. `doctor` flags this mismatch for you.

```bash
uploads --api-url http://localhost:8787 doctor
```

## Notes and cautions

- **Uploads are public and effectively permanent** until deleted. Never upload
  secrets, tokens, internal dashboards with sensitive data, or customer PII visible in
  a shot — crop/redact first.
- **Edge cache:** responses carry `Cache-Control: max-age=60`, so an overwrite or a
  delete can keep serving the old bytes from the edge for up to ~a minute. The object
  in R2 changes immediately.
- **Exit codes** (useful in scripts): `2` usage/missing-token, `3` unauthorized or
  not-found, `4` network, `1` other. `--json` also emits `{error,code,status}`.
- **MCP server:** the CLI can also be exposed to agents as a local stdio MCP server —
  `uploads mcp` — with tools mirroring the commands described here (`put`, `attach`,
  `list`, `delete`, `comment`, `health`, `doctor`) under the same config resolution.
  E.g. `claude mcp add uploads -- uploads --env-file /path/to/.env mcp`.
- **Agents on the Worker side:** the package also exports
  `createUploadsWorkerFileTools()` from `@buildinternet/uploads/agent` for exposing
  upload/list/delete as AI-SDK tools inside the Worker — separate from this CLI, and
  only relevant if you're building the agent tooling itself, not embedding images.
