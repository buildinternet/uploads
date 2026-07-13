---
name: uploads-cli
description: >-
  Host a file on uploads.sh and get a stable, public URL — then embed it in a
  GitHub PR or issue. Use this whenever you want to put a screenshot, diagram,
  before/after image, GIF, or any binary into a PR description, issue body, or
  PR/issue comment, or whenever you just need a durable public link to a local
  file. Triggers include "upload this", "host this image", "attach a screenshot
  to the PR", "add a before/after to the issue", "give me a public URL for this
  file", "put this in the PR comment", or having just built/changed something
  visual that a shot would make clearer. Reach for this instead of drag-and-drop
  or the GitHub API (an agent can't upload to github.com/user-attachments) and
  instead of hand-rolling cloud storage uploads.
---

# Uploading files to uploads.sh and embedding in GitHub

## What this does and why

GitHub's native image hosting (`github.com/user-attachments/…`) is only reachable
through an authenticated **browser session** — there is no `gh` CLI or REST endpoint
for it. So any image URL you put in a PR/issue body written with `gh … --body-file`
must already point at something publicly hosted.

This skill solves that with the **`uploads` CLI**: it PUTs a local file to the
uploads.sh API, which returns a stable public URL you can drop straight into
markdown. No browser, no repo bloat, no signing by hand. For PRs and issues it can
also create and maintain a single "attachments" comment for you via your local
`gh` auth.

For the common case, use `uploads attach <file...>`. It infers the current branch's
PR, uploads every file under stable attachment keys, and maintains the comment by
default:

```bash
uploads attach ./before.png ./after.png
uploads attach ./shot.png --issue 45 --repo buildinternet/uploads
```

Pass `--no-comment` when only stable URLs are wanted. Use `put` for lower-level
naming and output control.

The killer feature for GitHub: `--pr`/`--issue` produce **hash-free, stable keys**
(`gh/<owner>/<repo>/pull/<num>/<name>`), so re-uploading the same filename overwrites
in place and the URL never changes — you can update a screenshot after review and the
PR keeps rendering the new one (the API sets `Cache-Control: max-age=60`, so edits
propagate within ~a minute).

## Prerequisites

- **Node.js ≥ 22.**
- **The CLI.** Install globally for repeated agent use, or run it once with `npx`:
  ```bash
  npm install --global @buildinternet/uploads
  npx @buildinternet/uploads --help
  uploads --version
  ```
  Every example in this skill uses the **global** `uploads …` binary (as after
  install). Inside the uploads monorepo only, `pnpm uploads …` builds from
  local source first — do not write product/PR examples that way.
  Prefer `--json` or `--quiet` for scripted steps (keeps stderr clean and skips
  optional update-available hints).
- **A configured token** (one-time — see below). Check with `uploads doctor`.
- **`gh` CLI, authenticated** — only for the `--comment` / `comment` features that
  write to a PR/issue. Plain uploads don't need it.

## One-time setup

Config lives in a user-owned file so it survives skill reinstalls:

```
~/.config/buildinternet/config        # or $XDG_CONFIG_HOME/buildinternet/config
```

Resolution is **per key, first match wins**: CLI flags (`--api-url`, `--token`,
`--workspace`) → `UPLOADS_*` environment vars → `--env-file <path>` →
`$BUILDINTERNET_CONFIG` → the shared config file. For a one-off against a different
API or workspace, just export the var or pass `--env-file`.

The fastest path is `uploads login`. Have an uploads.sh administrator invite your
email to a workspace first, then run it once, interactively, to sign in:

```bash
uploads login          # opens a browser to approve sign-in, saves config, runs doctor
uploads login --workspace acme   # only needed if your account can access more than one
```

That's a one-time, human-in-the-loop step (device sign-in needs a browser); once the
config file is written, every later `uploads` invocation — including from a
non-interactive agent — just reads the saved token. Routine agents never need
`ADMIN_TOKEN`.

For headless machines with no browser at all, an operator can mint a token directly
(`/admin/tokens`, `ADMIN_TOKEN`-gated — see `docs/admin-tokens.md`) and hand it to the
agent as `UPLOADS_TOKEN`, or an enrollment code (`upe_…`, an alternative invite-link/code path — useful
when you don't have the recipient's email) can be exchanged with `uploads login --code`.
Neither is the normal path for new setups.

The resulting token defaults to 90 days and `files:read` plus `files:write`; it cannot
delete files unless an administrator explicitly grants `files:delete`. Verify or inspect
setup at any time:

```bash
uploads setup                                  # shows effective configuration
uploads doctor                                 # version + health + auth + workspace
uploads doctor --json
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

| Flag                                  | Purpose                                                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--alt <text>`                        | Alt text for the markdown (default: filename). Always write meaningful alt text.                                       |
| `--width <px>`                        | Emit sized `<img width=…>` HTML instead of `![]()` (markdown can't size images).                                       |
| `--repo <owner/repo>`                 | Repo segment of the auto key (default: git remote, or `UPLOADS_DEFAULT_REPO`).                                         |
| `--ref <id>`                          | PR/issue/branch/date segment (default: today, or `UPLOADS_DEFAULT_REF`).                                               |
| `--destination <id>`                  | Typed root: `screenshots` \| `gh` \| `f` (sets key prefix).                                                            |
| `--prefix <path>`                     | Key prefix (default: `screenshots`, or `UPLOADS_DEFAULT_PREFIX`).                                                      |
| `--key <key>`                         | Set the object key explicitly; skips the auto-naming below.                                                            |
| `--name <leaf>`                       | Clean filename for the key's leaf + default alt (no `/`); keeps the `--pr`/default path. Not with `--key`.             |
| `--dry-run`                           | Resolve + print the key and final public URL without uploading (one read, no write). Not with `--comment`/`--gallery`. |
| `--content-type <mime>`               | Override the content type (else inferred from extension; ignored when optimize rewrites the body).                     |
| `--frame <id>`                        | Opt-in chrome before optimize: `phone`, `browser`, `iphone-16-pro`.                                                    |
| `--frame-url <url>`                   | Address bar text for `--frame browser`.                                                                                |
| `--frame-fit cover\|contain`          | How the shot fills the screen (default: `cover`).                                                                      |
| `--no-optimize`                       | Skip client-side image optimization (default: still images → WebP). Or `UPLOADS_NO_OPTIMIZE=1`.                        |
| `--optimize-max-edge <px>`            | Max long edge when optimizing (default: 2400).                                                                         |
| `--optimize-quality <1-100>`          | WebP quality when optimizing (default: 85).                                                                            |
| `--keep-exif`                         | Keep EXIF/XMP/ICC when optimizing (default: **strip** for privacy). Or `UPLOADS_KEEP_EXIF=1`.                          |
| `--no-git`                            | Don't derive `--repo` from the git remote (or `UPLOADS_NO_GIT=1`).                                                     |
| `--format human\|url\|markdown\|json` | Control stdout. `--json` (global) forces json.                                                                         |
| `-w, --workspace <name>`              | Override workspace (wins over env and token inference).                                                                |

**Image optimization (default on):** PNG/JPEG and similar still images are re-encoded to
WebP (long edge capped at 2400px, quality 85) before upload so PR/issue embeds stay
lean. The object key/filename extension follows the output (e.g. `shot.png` →
`…/shot.webp`). **EXIF/XMP is stripped by default** (public URLs + privacy); pass
`--keep-exif` when the discussion needs the embedded image metadata. Animated GIF,
SVG, video, and non-images are left alone; if the optimized payload is not smaller,
the original is uploaded. Use `--no-optimize` when you need lossless originals.

**Frames (opt-in):** `--frame phone` (generic bezel), `--frame browser`, or
`--frame iphone-16-pro` (community device art, cached under
`~/.cache/uploads/frames`). Default is **no frame**.

**How keys work** — three paths, no extra naming modes:

| Intent                                | Command                                                        |
| ------------------------------------- | -------------------------------------------------------------- |
| Just upload it, give me a URL         | `uploads put ./file.png`                                       |
| Explicit typed destination            | `uploads put ./file.png --destination screenshots`             |
| Stable GitHub embed I might re-upload | `uploads put ./file.png --pr <num>`                            |
| Stable `--pr` path but a clean leaf   | `uploads put ./capture-2026-…Z.png --pr <num> --name hero.png` |
| I know exactly where it goes          | `uploads put ./file.png --key screenshots/…/x.png`             |

Timestamped captures break stable `--pr` keys — pass `--name hero.webp` to keep a
clean leaf. Use `--dry-run` to preview the exact public URL before uploading.

Default `put` is the fast path; you don't need `--key`, `--prefix`, or `--repo`. Without
`--key`, keys look like
`<prefix>/<repo-name>/<ref-or-date>/<basename>-<shorthash>.<ext>` — the short hash
prevents collisions without random names or a separate "preserve name" flag. Prefer
`--destination screenshots` (or `gh` with `--pr`/`--issue`) over inventing roots —
workspaces may allowlist only those destinations. Override with `--key` only when you
have a reason, and keep the key under an allowed root.

**Output formats** — pick what you'll consume:

```bash
uploads put ./shot.png --format url        # just the URL, for scripting
uploads put ./shot.png --format markdown   # just the ![]()/<img> snippet
uploads put ./shot.png --json              # {workspace,key,url,size,markdown}
```

## Custom metadata & search

Every object can carry queryable key-value metadata (distinct from optimize/frame
provenance) — tag uploads at put time, then find them later:

```bash
uploads put ./shot.png --meta app=myapp --meta page=settings --meta device=iphone-16
uploads meta get screenshots/myapp/42/shot.png
uploads meta set screenshots/myapp/42/shot.png page=onboarding --delete device
uploads list --meta app=myapp --meta page=settings   # ANDed, repeatable
uploads find app=myapp page=settings                 # same filter, positional pairs
```

Rules (validated client-side, fail-fast, before uploading): key
`^[a-z][a-z0-9._-]{0,63}$` (lowercase, dot-namespacing allowed, e.g. `gh.repo`);
value 1–512 printable ASCII characters; `--meta k=v` may repeat up to 24 times per
request; a value may itself contain `=` (only the first `=` splits key from value).
`content-sha256` is reserved (server-computed). `uploads attach` writes its own
`gh.*` reserved-by-convention keys automatically — see below.

## Public media galleries

Use galleries when several existing public uploads should be shared as one ordered collection.
A gallery has an opaque, API-returned public URL; do not derive one in scripts. **Anyone who
knows the URL can view the gallery and its media**. GitHub repository visibility does not make
it private, and a gallery does not pin objects against retention.

```bash
uploads gallery create --title "Settings redesign"
uploads gallery add gal_example screenshots/app/settings-before.webp screenshots/app/settings-after.webp
uploads put ./after.png --gallery gal_example --alt "Updated settings page"
uploads gallery show gal_example
uploads gallery link gal_example --github buildinternet/uploads#58
uploads gallery list --github https://github.com/buildinternet/uploads/pull/58
```

`gallery add` processes keys sequentially so it obtains a current optimistic version before
each mutation. With `--json`, its stable `added` and `failures` arrays make partial failures
safe for agents to inspect. A workspace may have up to 100 active galleries; each gallery permits up to 100 items and 20 linked external references. Deleting a gallery removes only its gallery record—not the objects.

Optionally link a gallery to a GitHub issue or PR with `uploads gallery link <gallery-id> --github <owner/repo#number>`. The CLI also accepts strict `https://github.com/<owner>/<repo>/issues|pull/<number>` URLs. Use `uploads gallery list --github <coordinate-or-url>` for the authenticated reverse lookup. This is metadata only: it does not make a gallery private or change its opaque identity.

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

These keys are deliberately predictable: they include the owner, repository, PR or
issue number, and filename. uploads.sh does not check GitHub visibility, so a private
or internal repository does **not** make the uploaded file private. Before using this
mode, confirm the media is safe for a public, guessable URL; otherwise redact it or do
not upload it.

Then reference the URL in the PR/issue markdown you write with `gh`:

```markdown
<img width="700" alt="Dashboard after" src="https://storage.uploads.sh/gh/myorg/myapp/pull/123/after.png">
```

`uploads attach` (below) additionally writes `gh.repo`/`gh.kind`/`gh.number`/`gh.ref`
as queryable metadata automatically, so `uploads find gh.ref=myorg/myapp#123` or
`uploads list --meta gh.repo=myorg/myapp` finds everything attached to that PR/issue
without needing the `gh/...` prefix. Add `--meta k=v` extras to `attach` for your own
pairs on top — a `--meta gh.*` override loses to the target's own `gh.*` values.

### Option B — managed attachments comment (`--comment` / `comment`)

Add `--comment` to upload **and** create/update a single marker-owned comment on the PR/issue. It keeps loose `gh/...` attachments and every public gallery linked to that PR/issue in clearly separate sections, with up to three available gallery images inline. It finds its own prior comment via a hidden marker and edits it in place — it never touches the description or other comments:

```bash
uploads put ./after.png --pr 123 --comment
```

The upload is authoritative; the comment is best-effort — if `gh` is missing or
unauthenticated, the upload still succeeds and you get a warning. To (re)sync the
comment without uploading anything (e.g. after several `--pr` uploads or gallery links), use the standalone command:

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
uploads list --meta app=myapp              # filter by metadata (repeatable, ANDed)
uploads find app=myapp page=settings       # same filter, human-friendly positional pairs
uploads list --all --json                  # paginate fully, machine-readable
uploads meta get <key>                     # show an object's metadata
uploads meta set <key> k=v [k=v…] [--delete k]…   # merge-set / delete metadata pairs
uploads delete <key>                       # remove an object
uploads delete <key> --dry-run             # show what would be deleted
uploads usage                              # storage / monthly upload counters (+ limits)
uploads reconcile                          # rebuild ledger from storage
uploads purge-expired                      # delete past retentionDays (if set)
uploads health                             # API liveness (no auth)
uploads doctor                             # version + health + auth + workspace + usage
uploads --version
```

`doctor` is the first thing to run when something's off — it reports the installed
CLI version, distinguishes a down API / bad token / workspace mismatch /
local-vs-prod URL, and prints targeted hints.

**Destructive preview:** `delete` supports `--dry-run`. `purge-expired` does not
yet ([#78](https://github.com/buildinternet/uploads/issues/78)); preview via
`list` / `usage` and retention settings.

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
`UPLOADS_DEFAULT_WIDTH`, `UPLOADS_NO_GIT`, `UPLOADS_NO_OPTIMIZE`, `UPLOADS_KEEP_EXIF`.

## Local development

Point at a locally running API (`pnpm dev` serves it on `:8787`). Tokens minted with
`workspace:add --local` only work against localhost; prod tokens need
`UPLOADS_API_URL=https://api.uploads.sh`. `doctor` flags this mismatch for you.

```bash
uploads --api-url http://localhost:8787 doctor
```

## Notes and cautions

- **Uploads are public and effectively permanent** until deleted. GitHub repository
  visibility is not an access control: private/internal PR and issue attachments remain
  public, and `gh/<owner>/<repo>/pull|issues/<num>/<filename>` keys are predictable.
  Never upload secrets, tokens, internal dashboards with sensitive data, or customer
  PII visible in a shot — crop/redact first.
- **Edge cache:** responses carry `Cache-Control: max-age=60`, so an overwrite or a
  delete can keep serving the old bytes from the edge for up to ~a minute. The object
  in storage changes immediately.
- **Exit codes:** `2` usage/token/file, `3` auth/policy, `4` network, `1` other.
  `--json` emits `{error,code,status}` — branch on `code`. Scripted formats
  (`json|url|markdown`) also print failures on stdout. Usage errors:
  `hint: uploads <cmd> --help`.
- **Update hints (stderr):** successful human runs may note a newer npm release
  (daily). Silence with `--quiet` / `--json` / `UPLOADS_NO_UPDATE=1`.
- **MCP:** `uploads mcp` (stdio) mirrors CLI tools; hosted MCP at
  `https://agents.uploads.sh/mcp`. `uploads install` sets up this skill + hosted MCP
  (short progress; `--verbose` / `--dry-run` available).
- **Agents on the Worker side:** the package also exports
  `createUploadsWorkerFileTools()` from `@buildinternet/uploads/agent` for exposing
  upload/list/delete as AI-SDK tools inside a Worker — only relevant if you're
  building agent tooling that runs on the server, not for everyday PR embeds.
