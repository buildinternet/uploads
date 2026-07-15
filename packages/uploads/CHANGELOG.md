# @buildinternet/uploads

## 0.10.1

### Patch Changes

- 039f3db: Docs: correct CLI examples to match real output. Optimize notes now show human
  sizes (`411.5 KB → 94.2 KB`) instead of raw bytes, `--pr` example keys reflect
  the WebP extension rewrite, and the README command list includes `login`,
  `whoami`/`status`, `logout`, `invite`, and `admin`.

## 0.10.0

### Minor Changes

- bb2f34f: Style command-level --help like the root overview; add --meta examples; add whoami/status and logout
- 3e0ceb9: Improve CLI overview: curated help, `help` + `completion`, brand-token colors, half-block mark header, auth/update banners

### Patch Changes

- 9458b2b: Print human-readable optimize sizes (e.g. `411.5 KB → 94.2 KB`) and note when a put overwrites an existing object (`replaced` on the API/JSON, `>> replaced existing object (same URL)` in human mode). `--dry-run` reports `would replace` / `"replaced": true` when the key already exists, without writing.
- 3daebbb: `uploads invite create` now says whether the invitation was emailed or whether the install has no email configured and the accept link must be shared by hand (`emailConfigured` also appears in `--json` output). Older auth workers that don't report the field keep the previous hedged copy.
- ef7fa68: `uploads login --workspace <name> --create` provisions the workspace during login when the account doesn't have it yet, so scripted and agent logins can self-onboard without an interactive prompt (device approval in a browser is still required once). The zero-workspace non-interactive error now points at the flag.
- a5f2e49: `uploads login` now says which auth host it is signing in to (with a self-hosting hint), includes the saved API URL in its success output and `--json` payload, and ends with a pointer to `uploads install` so agent users discover the skill + MCP setup command.

## 0.9.0

### Minor Changes

- d67c093: `uploads put` now stamps the four `gh.*` metadata pairs whenever it has a
  GitHub target, so screenshots hosted on the default `screenshots/…` path get an
  "Attached to" link on their `/f/` page. On by default: with `--pr`/`--issue`
  the explicit target is used (previously the stable key was written without
  metadata); otherwise `put` resolves the current branch's PR (or classifies a
  numeric `--ref` as pull vs issue) via `gh`. Disable with `--no-auto`,
  `--no-git`, or `UPLOADS_NO_AUTO_META=1`. Resolution is best-effort — a missing
  `gh`, no PR, or an API error uploads normally without metadata.

### Patch Changes

- 528d895: Metadata discoverability polish: `uploads find` / `list --meta` now print each
  match's matched metadata inline in human output (as `LIST_HELP` already
  promised, previously only in `--json`); `uploads meta get` on an object with no
  metadata prints a `(no metadata)` note to stderr instead of nothing; and
  `uploads attach` prints a `find these later: uploads find gh.ref=…` hint so its
  auto-written `gh.*` metadata is discoverable. README now lists the stdio MCP
  `set_metadata`/`find_files` tools and the `put`/`attach` `metadata` param.

## 0.8.0

### Minor Changes

- c5b36a3: Return `embedUrl` alongside durable `url` for shared dual-host CDN (GitHub Camo–friendly). CLI/MCP markdown and managed attachment comments prefer the embed host; override with `UPLOADS_EMBED_PUBLIC_BASE_URL`.
- 46b6860: Add queryable custom metadata to the CLI: `put --meta k=v` (repeatable), `attach`
  now writes `gh.repo`/`gh.kind`/`gh.number`/`gh.ref` automatically (plus its own
  `--meta` extras), new `meta get`/`meta set` commands, `list --meta k=v` and the
  `find k=v...` alias for filtering objects by metadata.

  MCP parity: the local stdio MCP's `put`/`attach` tools gain a `metadata` param
  (same gh.\* auto-injection as `attach`), and two new tools — `set_metadata`
  (merge-set/delete) and `find_files` (metadata filter) — mirror the CLI's
  `meta set`/`find`. The hosted MCP's `put` tool also gains a `metadata` param.

  `meta get`/`meta set` now hit `GET /v1/:workspace/files/:key?metadata=1` and
  `PATCH /v1/:workspace/files/:key` instead of a `/:key/metadata` sibling route
  — the original suffix route 404'd on real (slash-containing) keys once
  deployed.

- b1c87d8: CLI onboarding and agent-friendly put:

  - **`uploads install`** — short progress, no child stdout unless `--verbose`/failure;
    non-interactive skills (`-g -y -a '*'`); success next-steps; MCP without a token is
    skipped with a login nudge (skill still installs).
  - **Missing token** — onboarding copy (no `error:` prefix); exit non-zero; `--json`
    keeps `MISSING_TOKEN`. Rejected tokens stay `UNAUTHORIZED` with a re-login hint.
  - **`put --name <leaf>`** — clean key leaf on the stable `--pr`/default path.
  - **`put --dry-run`** — resolve key + public URL without writing (API `?dryRun=1`).
  - **Scripted failures** — `--format json|url|markdown` also print on stdout.
  - **`FILE_NOT_FOUND`** — distinct code (exit 2) for a missing local file.

- 1c5a38b: Add `uploads invite create` so workspace admins/owners can invite teammates by email via device login (no `ADMIN_TOKEN`). Invitees accept in the browser and run `uploads login`.

### Patch Changes

- 3f5c7e1: Device login (`uploads login`) now sends a recognizable CLI User-Agent so the web account page can tell when you've already signed in from the terminal.

## 0.7.0

### Minor Changes

- 2aee5b7: `uploads login` now signs you in through a browser by default: it opens a device-authorization page, you approve the request, and the CLI mints and saves a workspace token — no enrollment code to copy. When your account can access more than one workspace, pass `--workspace <name>`. The one-time enrollment-code path still works via `--code` / `--code-stdin`.
- 778d440: Gallery items now carry a `pageUrl` pointing at their standalone web page
  (`/g/<gallery>/<item>`), and gallery previews in the managed GitHub
  attachments comment deep-link to those pages instead of the gallery root.

### Patch Changes

- 17280ce: `uploads setup` and `uploads login --help` now lead with `uploads login` (device authorization) as the recommended way to sign in. Enrollment codes (`--code` / `--code-stdin`) are still supported and are now clearly described as a fallback for pre-existing invites. No behavior changes.

## 0.6.0

### Minor Changes

- 930bb4f: Add typed gallery client methods and CLI commands for creating, listing, viewing, deleting, and adding public gallery media.

### Patch Changes

- 44d0849: Hint on stderr when a newer npm release of the CLI is available (cached daily; silence with `--quiet`, `UPLOADS_NO_UPDATE=1`, or `NO_UPDATE_NOTIFIER=1`). Add `--version`/`-V`, include the CLI version on `uploads doctor`, add Examples to login/admin help, and point usage errors at layered `uploads <cmd> --help` instead of dumping the full root manual.
- a3e7c2f: Show public galleries linked to a GitHub PR or issue in the existing managed attachments comment, alongside legacy loose attachments, with up to three available images previewed inline per gallery.
- c828210: Add public gallery operations to local and hosted MCP tools.
- ecb9c33: Add CLI and typed-client support for linking public galleries to GitHub issues and pull requests.

## 0.5.0

### Minor Changes

- 97a2e3c: `uploads admin invite create --email <address>` now delivers the invite magic link
  by email instead of printing it. The API sends from `invites@uploads.sh` via
  Cloudflare Email Sending; delivery is rate-limited per recipient and audit-logged
  without the code or link. On success the CLI confirms delivery and does not print the
  secret; if delivery fails the invite is still created and the CLI prints the link as a
  fallback.
- 97a2e3c: `uploads admin invite create` now prints a single self-contained magic link by
  default. The one-time code rides in the link's URL fragment (`…/invite?id=…#code=…`),
  which browsers never send to a server, so the invite page can offer a one-click login
  command while the code stays out of query strings, server logs, and referrers—and
  opening the page neither logs nor consumes it. Pass `--separate-code` for the previous
  two-channel output (a non-secret page URL plus a code you deliver separately). The
  invite page also now shows which workspace the invitation is for.
- 2245f63: Add `uploads admin invite create` as the user-facing invitation command and return a separate, non-secret onboarding page URL alongside the one-time login code. Alternate deployments can derive the page origin from `--api-url` or set it explicitly with `--web-url`; the previous `admin enrollment create` spelling remains supported.
- 29c7e83: Parse the nested API error envelope (`error.code` / `error.message`) while still accepting the legacy flat `{ error: string }` shape.

### Patch Changes

- ff5495a: Warn in CLI and agent tool help that uploads and predictable PR/issue attachment keys remain public for private and internal repositories.

## 0.4.0

### Minor Changes

- 383c7e9: Send allowlisted object provenance on put (`X-Uploads-Meta-*`: client, version, optimize/frame flags, source name). Put/head return `metadata`, including server-computed `content-sha256` of the stored body.

### Patch Changes

- cea6cd6: Mark the package `sideEffects: false` so Workers that import helpers from the main entry (e.g. the remote MCP worker) can tree-shake Node-only image code (`sharp` / optimize / frame) and deploy cleanly.

## 0.3.0

### Minor Changes

- 4c52c52: Add optional `--frame` (phone/browser/iphone-16-pro) on put/attach before optimize, and link uploads.sh in the managed GitHub attachments comment footer.
- 75844bb: Optimize still images to WebP on `put`/`attach` (and MCP) by default for leaner GitHub embeds (EXIF stripped unless `--keep-exif`), with `--no-optimize` / `UPLOADS_NO_OPTIMIZE` escape hatch.
- 3d17c0a: Add typed destinations (`--destination screenshots|gh|f` / MCP `destination`) and map API key-policy denials (`key_prefix_not_allowed`, `key_too_deep`) to a dedicated CLI error with an actionable hint.

### Patch Changes

- d83783f: Print actionable stderr hints on storage/upload budget and payload-too-large failures (point at `uploads usage` and size policy flags).

## 0.2.0

### Minor Changes

- 0a0db13: Add `uploads install` to register the agent skill and the hosted remote MCP server in one step. Prefer `agents.uploads.sh` (workspace inferred from the bearer token); `mcp.uploads.sh` remains an alternate hostname.
- 0a0db13: Add `uploads mcp` — a stdio MCP server whose tools mirror the CLI (`put`, `attach`, `list`, `delete`, `comment`, `health`, `doctor`, and later usage tools) under the same config resolution, with an optional per-call `workspace` override.
- 0a0db13: Add workspace usage maintenance surfaces for agents and the CLI: `uploads usage`, `uploads reconcile`, and `uploads purge-expired` (plus matching MCP tools and a usage line on `uploads doctor`). Surfaces storage counters, optional budget remaining, ledger rebuild from storage, and retention purge when configured on the workspace.
