# CLI guide

The `@buildinternet/uploads` package wraps the API for scripting and GitHub
image embeds. Examples use the global `uploads` binary (same as after
`npm install -g @buildinternet/uploads`).

```bash
uploads put ./shot.png
# stdout: public URL + ready-to-paste markdown; stderr: human summary
```

Inside this monorepo only, `pnpm uploads …` builds the package first so you
pick up local source.

## Tokens

An uploads.sh administrator invites your email to a workspace; `uploads login`
opens a browser to sign in (GitHub or a magic link) and saves the resulting
workspace token. For local development, `pnpm workspace:add` prints a bearer
token once — save it with `uploads setup --token <token>` or into `.env` /
user config. Routine agents never receive or need `ADMIN_TOKEN`. See
[enrollment](enrollment.md).

## How keys work

Default `put` lands under `screenshots/…`. Prefer `--destination screenshots`
(or `gh` with `--pr`/`--issue`) over inventing roots — workspaces may allowlist
only those destinations. Use `--pr`/`--issue` for stable, hash-free GitHub
keys; use `--key` only for an exact path under an allowed root.

More output control:

```bash
uploads put ./shot.png --format url
uploads put ./shot.png --repo myorg/myapp --ref 1722 --width 700
uploads put ./mobile.png --frame phone
uploads --version
uploads doctor
```

See [`packages/uploads/README.md`](../packages/uploads/README.md) for globals
(`--version`, update hints, quiet/json) and the full command list.

## GitHub embeds

GitHub's native image hosting only works through a browser session — agents
and `gh` need a public URL first. The CLI uploads to R2 and returns stable
markdown you can drop into a PR or issue.

**Stable PR/issue attachments** (`--pr` / `--issue`) use hash-free keys so
re-uploading the same filename overwrites in place and the URL never changes:

```bash
uploads put ./after.png --pr 123 --alt "Dashboard after"
# key: gh/<owner>/<repo>/pull/123/after.png
```

**Managed attachments comment** (`--comment`, requires local `gh` auth)
creates or updates a single comment listing every file attached to that
PR/issue — the upload still succeeds if `gh` is unavailable:

```bash
uploads put ./after.png --pr 123 --comment
uploads comment --pr 123   # re-sync without uploading
```

`uploads attach` combines the two: it detects the GitHub repository and
current PR through `gh`, uploads all files, and creates or updates one managed
attachments comment. Use `--pr <number>` or `--issue <number>` when inference
is not possible, and `--no-comment` when only the public URLs and Markdown are
wanted.

**Re-upload / hot-swap:** putting again to the same key overwrites the object
in place. There is no confirmation prompt (agents and re-runs need this). The
public URL stays the same so every embed updates after cache revalidation.
Human mode prints `>> replaced existing object (same URL)` when the API
reports an overwrite; JSON includes `"replaced": true|false`.

> **Privacy:** Hosted files are served from a public CDN with no link to GitHub
> repo visibility. A screenshot on a private PR is still reachable by anyone who
> knows or guesses the URL — `--pr`/`--issue` keys embed the repo path and
> filename (`gh/myorg/myapp/pull/123/after.png`), so generic names are easier
> to guess than hashed keys. Treat uploads as public; don't host secrets or
> sensitive UI. Tighter access controls for private repos are planned — see
> [roadmap](roadmap.md).

## Custom metadata

Tag uploads with queryable key/value pairs so you can find them later
(`uploads find`, `uploads list --meta`, the account search UI). Distinct from
optimize/frame provenance.

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

Rules: keys `^[a-z][a-z0-9._-]{0,63}$` (lowercase; dots allowed); values 1–512
printable ASCII; at most 24 pairs per request. Re-upload **with** `--meta`
replaces the whole metadata set; re-upload **without** `--meta` leaves existing
pairs alone. `uploads attach` and `put --pr`/`--issue` also stamp `gh.repo` /
`gh.kind` / `gh.number` / `gh.ref` automatically.

Non-`gh.*` metadata may appear on the public `/f/…` file page — don't store
secrets or private notes.

## Public galleries

Galleries are ordered collections of existing workspace uploads with an opaque
public URL. Create one and add uploads with the installed CLI:

```bash
uploads gallery create --title "Release screenshots"
uploads put ./after.png --gallery gal_example
uploads gallery show gal_example
uploads gallery link gal_example --github buildinternet/uploads#58
uploads gallery list --github https://github.com/buildinternet/uploads/pull/58
```

Use `uploads gallery link <gallery-id> --github <owner/repo#number>` to record
an optional GitHub issue or PR reference. `uploads gallery list --github
<coordinate-or-github-url>` performs an authenticated reverse lookup. The link
does not change gallery identity or visibility.

> **Privacy:** A gallery is public to anyone with its URL; it does not inherit
> GitHub or repository visibility. Removing or deleting a gallery does not
> delete its uploaded media or exempt it from retention.

## Agent skill

For agent runtimes, install the checked-in skill as well:

```bash
npx skills add buildinternet/uploads --skill uploads-cli
```

See [`skills/uploads-cli/SKILL.md`](../skills/uploads-cli/SKILL.md) for
agent-oriented usage and [api.md](api.md) for REST routes.
