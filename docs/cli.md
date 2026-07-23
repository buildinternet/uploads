# CLI guide

The `@buildinternet/uploads` package wraps the API for scripting and GitHub
image embeds. Examples use the global `uploads` binary; install it with
`npm install -g @buildinternet/uploads`. Inside this monorepo, `pnpm uploads …`
builds the package first, so you pick up local source.

This guide covers the everyday flows. For the full command list, the globals,
and the exit codes, run `uploads help --all` or see
[`packages/uploads/README.md`](../packages/uploads/README.md).

## Getting started

```bash
uploads login          # sign in via browser; saves your workspace token, then runs doctor
uploads whoami         # show the active workspace + token (alias: uploads status)
uploads install        # install the agent skills + register the hosted MCP server
uploads put ./shot.png # stdout: public URL + ready-to-paste markdown; stderr: human summary
```

`login` opens a browser to authorize this device. The approval page asks which
workspace to sign in to — pick one, or name a new one if the account has none.
So `uploads login` needs no flags, even when you belong to several workspaces.
The browser settles the workspace before you approve the device: if your account
can't reach a workspace, the page refuses it there, rather than reporting a
success that then fails in your terminal.

Pass `--workspace <name>` to preselect a workspace in the browser; you can still
change it there. Add `--create` to provision one by name — the one thing the
picker can't express. An invitation from a workspace admin also works: `login`
trades an enrollment code for a saved workspace token, and `logout` removes it.
When something's off, `uploads doctor` checks health, auth, and workspace
access. Routine agents never receive `ADMIN_TOKEN` and don't need it. See
[enrollment](enrollment.md).

For local development, `pnpm workspace:add` prints a bearer token once. Save it
with `uploads setup --token <token>`, or into `.env` or user config.

## Command overview

| Command                 | What it does                                              |
| ----------------------- | --------------------------------------------------------- |
| `attach <file…>`        | Attach media to the current PR (stable URLs + comment)    |
| `put <file>`            | Upload one file → public URL + GitHub markdown            |
| `comment`               | Create/update a PR/issue attachments comment (via `gh`)   |
| `list` / `find k=v`     | List objects, optionally filtered by queryable metadata   |
| `meta get` / `meta set` | Read or merge-set an object's queryable metadata          |
| `gallery …`             | Create and organize public media galleries                |
| `delete <key>`          | Delete an object                                          |
| `usage`                 | Workspace storage / upload counters                       |
| `install`               | Install the agent skills + register the remote MCP server |
| `login` / `logout`      | Sign in (browser or enrollment code) / clear saved token  |
| `whoami` (`status`)     | Show the active workspace and token                       |
| `invite`                | Invite a teammate to a workspace (workspace admin)        |
| `doctor` / `health`     | Health + auth + workspace checks / API liveness           |
| `setup` / `config`      | Inspect and configure CLI settings                        |
| `mcp`                   | Serve MCP over stdio (tools mirror the CLI)               |

Run `uploads <command> --help` for a command's flags.

## How keys work

By default, `put` lands under `screenshots/…`. Prefer `--destination
screenshots` (or `gh` with `--pr`/`--issue`) over inventing roots, since a
workspace may allowlist only those destinations. Use `--pr`/`--issue` for
stable, hash-free GitHub keys; use `--key` only for an exact path under an
allowed root.

These flags give you more control over the output:

```bash
uploads put ./shot.png --format url
uploads put ./shot.png --repo myorg/myapp --ref 1722 --width 700
uploads put ./mobile.png --frame phone
uploads --version
uploads doctor
```

The globals `--json` and `--quiet`, and the update hints, live in
[`packages/uploads/README.md`](../packages/uploads/README.md).

## GitHub embeds

GitHub's native image hosting works only through a browser session, so agents
and `gh` need a public URL first. The CLI uploads to R2 and returns stable
markdown you can drop into a PR or issue.

**Stable PR/issue attachments** (`--pr` / `--issue`) use hash-free keys. So
re-uploading the same filename overwrites in place, and the URL never changes:

```bash
uploads put ./after.png --pr 123 --alt "Dashboard after"
# key: gh/<owner>/<repo>/pull/123/after.webp  (PNG optimized to WebP; extension follows the output)
```

**Managed attachments comment** (`--comment`, requires local `gh` auth) creates
or updates a single comment listing every file attached to that PR or issue. The
upload still succeeds if `gh` is unavailable:

```bash
uploads put ./after.png --pr 123 --comment
uploads comment --pr 123   # re-sync without uploading
```

`uploads attach` combines the two: it detects the GitHub repo and current PR
through `gh`, uploads all the files, then creates or updates one managed
attachments comment. Pass `--pr <number>` or `--issue <number>` when it can't
infer the target, and `--no-comment` when you want only the public URLs and
markdown.

**Re-upload / hot-swap.** Overwrite behavior depends on the key (issue #174).
`attach`, `put --pr`, and `put --issue` always overwrite the object in place,
with no confirmation prompt, because agents and re-runs need this. The public
URL stays the same, so every embed updates after the cache revalidates. Human
mode prints `>> replaced existing object (same URL)` after a real put; JSON
includes `"replaced": true|false`. Preview first with `--dry-run`: if the key
already exists, it reports `>> would replace existing object (same URL)` (and
`"replaced": true` in JSON) without writing.

Every other key is **strict** — an explicit `--key`, or the default put path
with no `--pr`/`--issue`. Re-uploading to an existing key refuses with a
`key_exists` error (the JSON error's `details.url` names the existing object)
instead of overwriting. Pass `--replace` to opt in for that one call, or set
`UPLOADS_OVERWRITE=1` to restore always-overwrite behavior for every strict put.
`--dry-run` previews the refusal too, printing `>> would refuse: key already
exists` without writing.

> **Privacy:** A public CDN serves hosted files, with no link to GitHub repo
> visibility. A screenshot on a private PR is still reachable by anyone who knows
> or guesses the URL. A `--pr`/`--issue` key embeds the repo path and filename
> (`gh/myorg/myapp/pull/123/after.png`), so generic names are easier to guess
> than hashed keys. Treat uploads as public; don't host secrets or sensitive UI.
> Tighter access controls for private repos are planned — see [roadmap](roadmap.md).

## Custom metadata

Tag an upload with queryable key/value pairs so you can find it later, via
`uploads find`, `uploads list --meta`, or the account search UI. This metadata
is separate from optimize/frame provenance.

Suggested pairs for screenshots:

| Key    | Example                             | Meaning                          |
| ------ | ----------------------------------- | -------------------------------- |
| `url`  | `https://app.example/settings`      | Page URL the shot was taken from |
| `path` | `/settings` or `Settings > Profile` | In-app route or nav path         |
| `app`  | `web`, `ios`, `android`             | Surface / product shown          |

```bash
uploads put ./settings.png \
  --meta url=https://app.example/settings \
  --meta path=/settings \
  --meta app=web

uploads attach ./mobile-checkout.png \
  --meta url=https://app.example/checkout \
  --meta path=/checkout \
  --meta app=ios

uploads find app=web path=/settings
uploads meta get screenshots/myapp/42/settings.webp
uploads meta set screenshots/myapp/42/settings.webp page=onboarding --delete path
```

Rules: keys match `^[a-z][a-z0-9._-]{0,63}$` (lowercase; dots allowed); values
are 1–512 printable ASCII; at most 24 pairs per request. Re-uploading **with**
`--meta` replaces the whole metadata set; re-uploading **without** `--meta`
leaves existing pairs alone.

`uploads attach` and `put --pr`/`--issue` also stamp `gh.repo`, `gh.kind`,
`gh.number`, and `gh.ref` automatically, plus `gh.title` when local `gh` can
resolve the PR/issue title. Title resolution is best-effort and never blocks the
upload.

Branch staging (`attach --branch`) stamps `gh.status=staged`, which promotion
flips to `promoted`. Query in-flight files with `uploads find gh.status=staged`.
Promotion only accepts a staged file while it's fresh: 30 days after
`gh.staged-at` (`FRESHNESS_WINDOW_MS`, `apps/api/src/github-promote.ts`) the file
stops being promotable, but it **keeps serving** — nothing deletes it. There is
no staging reaper (see `docs/deletion.md`); once a file ages out of the promotion
window it just sits there, still reachable at its original URL, until
per-workspace retention or an explicit `files:delete` removes it.

On a `gh.*`-tagged upload, the server also stamps `gh.uploader` (GitHub login)
and `gh.uploader-id` from the user who minted the bearer token. These are
attribution only, not access control, and the server overrides any
client-supplied value for them.

Non-`gh.*` metadata may appear on the public `/f/…` file page, so don't store
secrets or private notes.

## Public galleries

A gallery is an ordered collection of existing workspace uploads, with an opaque
public URL. Create one and add uploads with the installed CLI:

```bash
uploads gallery create --title "Release screenshots"
uploads put ./after.png --gallery gal_example
uploads gallery show gal_example
uploads gallery link gal_example --github buildinternet/uploads#58
uploads gallery list --github https://github.com/buildinternet/uploads/pull/58
```

Use `uploads gallery link <gallery-id> --github <owner/repo#number>` to record an
optional GitHub issue or PR reference. `uploads gallery list --github
<coordinate-or-github-url>` does an authenticated reverse lookup. The link
doesn't change gallery identity or visibility.

> **Privacy:** A gallery is public to anyone with its URL; it doesn't inherit
> GitHub or repository visibility. Removing or deleting a gallery doesn't delete
> its uploaded media or exempt it from retention.

## Agent skills

For agent runtimes, install the checked-in skills too (`uploads install` does
this for you):

```bash
npx skills add buildinternet/uploads
```

[`skills/github-screenshots/SKILL.md`](../skills/github-screenshots/SKILL.md) is
the workflow skill — screenshots and recordings into PRs and issues.
[`skills/uploads-cli/SKILL.md`](../skills/uploads-cli/SKILL.md) is the full CLI
reference it defers to. See [api.md](api.md) for the REST routes.
