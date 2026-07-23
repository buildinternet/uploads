# @buildinternet/uploads

## 0.28.0

### Minor Changes

- 733e206: Add `uploads update`. It upgrades the globally installed CLI, then re-runs
  `uploads install` so the agent skills and the MCP registration match the new
  version. When the CLI is already current it still refreshes them, because they
  drift on their own. The upgrade step detects npm, pnpm, and bun global
  installs, and refuses to overwrite a workspace checkout or an npx cache. The
  existing update hint and help banner now name `uploads update`.

### Patch Changes

- 52da4d8: The local-`gh` fallback for the managed attachments comment (used when the GitHub App bot path is unavailable or unauthorized) now collapses duplicate marker comments the same way the bot path does: it collects every comment carrying the workspace's exact namespaced marker, patches the oldest, and best-effort deletes the rest, swallowing delete failures. Previously this path only ever patched the first match it found, so a duplicate left by a concurrent-create race (two `uploads attach` runs racing before either found an existing comment) never healed. Legacy unnamespaced marker comments are still adopt-only and are never deleted.
- a6b1ae2: `uploads comment` (and the `comment` MCP tool) now always hunts for the managed comment's marker instead of patching its cached comment id, so a duplicate comment left by a create race is collapsed on the next explicit resync rather than surviving until the id cache expires. Attach and screenshot syncs keep the cached-id fast path.

## 0.27.0

### Minor Changes

- ee057cc: `meta set` refreshes the managed PR/issue comment when it changes `path` or `state` on a `gh/…`-keyed attachment, so backfilled metadata shows up without waiting for the next attach. If the bot endpoint is unavailable it prints a `uploads comment` hint instead of failing the write. The server side also self-heals duplicate managed comments left by a create race: the oldest is kept and updated, extras are deleted on the next sync (issue #470).
- 5fbf612: `uploads screenshot` (CLI and local MCP) now stages against the current git branch by default when run on a non-default branch with no `--pr`/`--issue`/`--branch` target — same key and metadata as `attach --branch`, so derived facts (`path`/`url`/`env`/`viewport`, plus `--state`) survive through to the PR once it opens instead of being lost at attach time. Opt out with `--no-git`, or an explicit `--ref`/`--prefix`/`--destination`.

  `attach` and `put --pr`/`put --issue` now print a `tip: add --meta path=/route so this shot is findable by page` (stderr, plus a JSON `hint` field) when an uploaded image ends up with no `path` metadata. Respects `--quiet`.

- 5d29337: `uploads screenshot --out` now also writes a sidecar manifest (`<file>.uploads.json`) recording the capture's derived metadata (path/url/env/viewport, plus `--state` if given) with a content hash. A later `uploads put`/`attach` of that exact file automatically picks the metadata back up — explicit `--meta`/`--state` still win, and a regenerated or edited file silently loses its sidecar. Disable with `--no-sidecar`.

### Patch Changes

- 14edc6f: Docs: document the managed-comment self-heal dedupe and the `meta set`
  comment re-sync (path/state) added in #471, in the CLI README, the
  uploads-cli skill, and the GitHub App docs page.

## 0.26.1

### Patch Changes

- 7fcbef5: `uploads usage` shows the workspace plan (Free or Pro) when the API reports it,
  alongside storage/upload meters. Free is not unlimited — caps appear on the
  meters. Additive `plan` field on the usage response.
- 8f95bed: Device login now saves a session token and keeps `session.cliVersion` fresh so
  the account Sessions list can show your current CLI version after upgrades
  without re-login.
- 2a2d2e4: Relicense from MIT to Apache 2.0. No functional change — the package's `license`
  field and the repository LICENSE file now read Apache-2.0.

## 0.26.0

### Minor Changes

- daf2d40: The managed attachments comment now shows a neutral empty state when every attachment and gallery is removed from a PR/issue. Deleting the last asset and re-running `uploads comment` (or a `put --comment`) rewrites the existing comment in place to "No attachments are currently associated with this pull request." — it is never deleted (a later upload repopulates it) and is never created just to say it is empty. `uploads comment` reports this as a "cleared" message rather than "updated (0 files)".

## 0.25.0

### Minor Changes

- b810875: Managed attachments comment renders before/after pairs side by side

### Patch Changes

- fe32621: Align the managed comment's filename-stem before/after fallback with the file page: a delimiter-bounded token anywhere in the stem now pairs (not just at the start or end).
- 140951e: Correct the README's branch-staging retention claim: staged files are never
  deleted by promotion (copy-and-keep), only skipped by promotion after 30
  days.

## 0.24.0

### Minor Changes

- d9cd253: Bare `put` on a non-default git branch now stages to the branch prefix by default — same key and `gh.*` metadata as `attach --branch`, so it auto-attaches to that branch's PR when one opens. Only applies when none of `--pr`/`--issue`/`--key`/`--ref`/`--prefix`/`--destination` is set and `--no-git` isn't passed; the default branch, detached HEAD, not being in a git repo, `--no-git`, or any of those explicit flags keeps the classic dated layout. Prints a one-line staging note (same suppression as the existing bare-put nudge), and the stage-time binding warning from `attach --branch` now fires on this path too. Local stdio MCP `put` mirrors the same default.
- c472755: `attach --branch` now warns at stage time when the repo won't auto-attach staged files at PR open — either because it isn't linked to your workspace yet, or because it's linked to a different workspace. Advisory only: staging always succeeds regardless. Suppressed by `--quiet`, `UPLOADS_NO_NUDGE=1` (env or config), same as the bare-put nudge (#396).
- b3b02c2: New `uploads staged [--branch <name>] [--repo <owner/name>] [--format json]`: a read-only view of what's staged for a branch (`attach --branch` / bare `put` on a non-default branch) and whether it will auto-attach once a PR opens. One `list` call against the branch staging prefix plus the repo-binding check (files:read only, no new server surface); `--format json` always prints a valid document, even with nothing staged. Also available as the `staged` tool on the local stdio MCP server.

## 0.23.0

### Minor Changes

- e4a9123: `put` with no `--pr`/`--issue`/`--key` on a non-default git branch now prints a one-line nudge toward `--pr <num>` or `attach --branch`. Human mode writes it to stderr; `--format json` adds an additive `hint` field. Suppress with `--quiet`, `UPLOADS_NO_NUDGE=1`, or config `UPLOADS_NO_NUDGE=1`.
- 55880e3: Render video attachments with a poster thumbnail in the managed comment.

## 0.22.1

### Patch Changes

- b3a0719: `uploads attach --branch` now reminds you that staged files auto-attach to the branch's PR when it opens (or via `uploads attach --promote`), reinforcing the stage-as-you-go loop for agents.
- ce237d4: Omit a bare `/` path from managed attachment comment captions (still stored and searchable).

## 0.22.0

### Minor Changes

- c553499: Managed GitHub attachment comments now show an upload's canonical `path` and `state` metadata — a screenshot tagged `--state before` on `/settings` renders as `/settings · before` beneath the image instead of just its filename. Attachments without that metadata render exactly as before.
- e87bca5: Device login now picks the workspace in the browser. `uploads login` works with
  no flags for every account — the approval page lists the workspaces you can use,
  creates one if you have none, and refuses to approve a workspace your account
  can't reach instead of reporting success and failing in the terminal.
  `--workspace` becomes an optional preselect; `--workspace <name> --create` still
  provisions by name.

## 0.21.0

### Minor Changes

- 963ea12: Add a canonical metadata vocabulary for uploads. `screenshot` now derives
  `url`, `path`, `env`, `theme` and `viewport` from the capture, and `put`
  promotes an allowlist of image EXIF (`viewport`, `device`, `software`,
  `captured`) into queryable metadata before stripping it from the bytes. New
  `--state` and `--app` flags, and matching MCP params, cover what the CLI
  cannot derive. `uploads find path=/settings state=after` is the payoff.

  The MCP `metadata` description previously suggested `page` and `resolution`;
  it now names the canonical keys and points at `path` as the one to search by.

  Two behavior changes worth reading before upgrading:

  - `device` and `software` come from EXIF that was previously discarded, and
    promoted metadata renders on the public file page. GPS coordinates, serial
    numbers and personal-name tags are never promoted.
  - Metadata sent on a put fully replaces that key's stored set. Because derived
    keys count as metadata, a re-upload that derives anything now replaces the
    set where it previously left it untouched. Pass `--no-auto` when re-uploading
    a key whose metadata you curated with `uploads meta set`.

  Opt out of the whole derived tier with `--no-auto` or `UPLOADS_NO_AUTO_META=1`.

### Patch Changes

- 81b220a: Fixes a gap where a workspace could implicitly bind (or explicitly claim via `uploads github link`) another org's GitHub repo the App is installed on, letting it post or deface the `uploads-sh[bot]` comment there. Claiming an unbound repo now requires the calling workspace's linked GitHub account to have push (or higher) access to that repo, verified live via the App's installation token. An unauthorized claim gets the same soft `{ posted: false, reason: "not_authorized" }` / `{ claimed: false, reason: "not_authorized" }` decline as posting to an already-bound repo — never a server error, and the CLI never falls back to `gh` for it. Repos bound before this check shipped keep working unchanged.
- f65813f: Export the canonical metadata helpers (`stateProp`, `appProp`,
  `canonicalMetaFromArgs`, `metadataArgWithCanonical`) from the `/mcp` entry
  point so the hosted MCP server can reuse them instead of keeping its own copy
  of the metadata tool description.

## 0.20.0

### Minor Changes

- 7fbb1a7: `put` (and the local/hosted MCP `put` tool) now refuse to overwrite an existing object on a "strict" key — an explicit `--key`, or the default put path with no `--pr`/`--issue` — instead of silently replacing it. `attach`, `put --pr`, and `put --issue` are unchanged: they always hot-swap in place so PR/issue embed URLs stay stable.

  Pass `--replace` (MCP: `replace: true`) to opt in for one call, or set `UPLOADS_OVERWRITE=1` to restore the old always-overwrite behavior for strict-path puts. `--dry-run` now previews the refusal too (`>> would refuse: key already exists`).

## 0.19.0

### Minor Changes

- c674e0f: `uploads login` now mints a full-scope token by default (files:read, files:write, files:delete) so the CLI's own `delete` command works out of the box; pass `--scopes` to narrow it. `uploads doctor` now shows the token's scopes and hints when files:delete is missing.

### Patch Changes

- 9210e1c: Scope failures are now actionable: an `insufficient_scope` API error surfaces as "token lacks the files:delete scope" with a hint to re-run `uploads login` (or mint with `--scopes`), instead of a bare "forbidden".

## 0.18.0

### Minor Changes

- 088a5bd: Branch-staged attaches now stamp `gh.status=staged`, and server-side promotion flips the staged original to `gh.status=promoted`. In-flight staged media becomes a plain equality query: `uploads find gh.status=staged` (narrow with `gh.branch=<name>` or `gh.repo=<owner/name>`).

## 0.17.0

### Minor Changes

- fcf2b0d: `uploads github doctor` now reports `issue_comment` as a recommended (non-gating) webhook event subscription. When the GitHub App is otherwise healthy but not subscribed to `issue_comment`, doctor prints a `note:` line and still exits 0 — required events (`issues`, `pull_request`) are unaffected. `--json` output gains `recommendedEvents` and `missingRecommendedEvents`; older servers whose health payload predates these fields are handled gracefully.

## 0.16.1

### Patch Changes

- 9e06ef6: Warn on stderr when the linked dev CLI's `dist/` predates `src/` (or is missing), so testing a change against the linked `uploads` binary can no longer silently exercise stale compiled code — a false alarm that's bitten local debugging more than once. The check is a no-op for published npm installs (no `src/` tree ships in the tarball) and costs at most a couple of directory walks.

  Also update the `put --comment` MCP tool description and the `comment` MCP tool description, which still described posting "via local gh auth" as the primary path — both now match the CLI's own help text: the server-side bot comment (`uploads-sh[bot]`) is tried first, with local `gh` as a fallback.

- c82a14d: Managed GitHub attachments comment now ends with a short "Add media" hint pointing readers at `uploads put <file> --pr <N> --comment` (or `--issue <N>`) and the docs, so anyone viewing the comment can learn how to contribute media themselves.

## 0.16.0

### Minor Changes

- 87f5626: Add `uploads github doctor` to check whether the GitHub App is subscribed to the webhook events uploads.sh needs (`issues`, `pull_request`). A missing subscription previously failed silently — the App's ping stayed green while webhook auto-promotion and title-cache invalidation quietly did nothing.
- 65cb8b9: Add `uploads github unlink` to release a workspace's GitHub repo binding (self-serve counterpart to `uploads github link`), and point `github link`'s already-bound-elsewhere output at the remedy.

### Patch Changes

- bb149da: `uploads attach --branch <name>` now rejects a value that looks like a file
  (an existing path on disk, or a name with a media/document extension like
  `.png`/`.pdf`) instead of silently swallowing it as the branch name. Fixes
  `uploads attach --branch shot.png` staging under a branch literally named
  "shot.png" — use `uploads attach shot.png --branch` (auto-detect the current
  branch) or `uploads attach --branch <name> shot.png` instead. Ordinary dotted
  branch names like `v1.2` or `release/1.2` are unaffected.
- 9baf580: Stop falling back to the local `gh` path when the server declines a comment post with `not_authorized` (cross-tenant repo binding) — surface the decline with a hint to `uploads github link --status` instead, since a silent gh fallback would just work around the server-side gate with the human's own credentials.

## 0.15.0

### Minor Changes

- 3983c46: `uploads attach --branch [name]` and `uploads screenshot --branch [name]` stage files against a git branch before a pull request exists — for coding agents working a branch that hasn't opened a PR yet. Keys land under `gh/<owner>/<repo>/branch/<branch>/<filename>` with `gh.repo`/`gh.kind=branch`/`gh.branch`/`gh.staged-at` metadata; no managed comment is created since there's no PR/issue to comment on yet.
- 906c54d: `uploads attach` now auto-promotes branch-staged attachments (`attach --branch`) into a PR's attachment prefix the first time you attach to that PR, before refreshing the managed comment — no extra step needed once a PR opens for a branch you staged files against. Use `uploads attach --promote` (no file arguments) to promote and refresh the comment without uploading anything new, or `--no-promote` to opt out of the automatic behavior. Promotion talks to a new server endpoint and degrades silently (never fails the attach) when that endpoint isn't available yet.
- 3d13d34: Managed GitHub comments now cap inline images at 16 (the rest collapse into a `<details>` list) and use a per-workspace marker so two workspaces sharing a repo no longer clobber each other's comment (legacy comments are adopted and migrated automatically). Adds `uploads github link` to inspect or explicitly claim a workspace's binding to a repo.

### Patch Changes

- 01e2a5a: Managed GitHub comment attachments now link to their uploads.sh file page (metadata, dates, video player) instead of raw file bytes.
- 235eabe: When the uploads.sh GitHub App is installed but hasn't been granted Issues /
  Pull requests write yet, `uploads comment` (and `--comment`) now prints a short
  note explaining that an admin must approve the added permissions — with a link
  to do it — before falling back to the local `gh` path, instead of falling back
  silently.

## 0.14.0

### Minor Changes

- b9955b2: `uploads attach` and `put --pr`/`--issue` now also stamp `gh.title` with the resolved PR/issue title (best-effort via local `gh`, never blocks the upload) so the connected-work label in the workspace rail can show the real title instead of the bare `owner/repo#123` ref.
- 9b73337: Managed attachments comment can now be posted by the uploads.sh GitHub App as
  `uploads-sh[bot]` when the App is installed on the target repo, so `--comment` /
  `uploads comment` no longer require a locally authenticated `gh`. Falls back to
  the existing `gh`-authored comment where the App is not installed.

  Both paths now find and edit the existing managed comment on threads past 100
  comments (the `gh` fallback paginates the lookup), so updating attachment media
  edits the one comment in place instead of posting a duplicate.

## 0.13.1

### Patch Changes

- 0d1db80: Widen the token-mint scope types to accept `"operator:read"` and `"operator:write"` alongside the existing file scopes, so CLI/SDK callers can request operator scopes minted by an admin session (#257). No new commands or flags.
- dd388a9: Widen the token-mint scope types to accept `"workspace:invite"` and `"workspace:manage"` alongside the existing file and operator scopes, so CLI/SDK callers can request org-admin-gated workspace-governance scopes minted via `POST /v1/tokens` (#262). No new commands or flags.

## 0.13.0

### Minor Changes

- a5c9a1a: Export `mapBounded` from the `/mcp` entry so runtime-agnostic MCP tool sets (like the hosted worker's multi-file `put`) can share the SDK's bounded-concurrency batch helper.
- 7fa7d06: Publish the `uploads screenshot` command (added in #202 but never released). Captures a URL or local HTML file and hosts it in one call, with local Chrome and server-side `/v1/render` backends. Supports `--viewport WxH@Nx`, `--wait`, `--selector`, `--full-page`, `--dark`/`--light`, `--via local|remote`, and `--out <file>` (with `--no-upload` for file-only).

  Adds agent-friendly capture controls: `--hide <css>` (repeatable) hides overlays before capture and localhost/private targets auto-hide known framework dev toolbars (opt out with `--no-hide-dev-tools`); `--reduced-motion` settles animations; and `--eval <js>` / `--init-script <file>` run setup JS before capture (local backend only).

## 0.12.1

### Patch Changes

- 4d0bfad: Fix PR inference from the current branch: `gh pr view --repo` requires an explicit selector, so pass the current branch name. `uploads attach`/`put` from a branch with an open PR now resolve it instead of erroring.

## 0.12.0

### Minor Changes

- e6538ba: New `uploads screenshot <url|file.html>` command: capture a URL or a local
  `.html` file and host it in one step, sharing the `put` upload pipeline
  (`--frame`, optimize-by-default, `--pr`/`--issue` attachment + `--comment`).
  Two capture backends selected by `--via auto|local|remote` (default `auto`,
  or `UPLOADS_SCREENSHOT_VIA`): `local` drives an already-installed
  Chrome/Chromium via `playwright-core` (an optional dependency — no browser
  download), while `remote` renders server-side through a new uploads.sh
  render endpoint. `auto` prefers local when a browser is found, else falls
  back to remote; localhost/private-network targets and `.html` files stay
  local-only. Also available as an MCP tool and reported in `uploads doctor`.

## 0.11.1

### Patch Changes

- 4bc3637: Parallel multi-file `attach` (CLI + MCP) with partial-failure `uploads`/`failures` results
- 2a4b2ac: `uploads install` now prints a closing next-step hint when only some agent skills succeed (or all fail), instead of leaving a half-installed state with no guidance after the per-step failure lines.
- cd5c89f: Add MCP `get_metadata` (stdio + hosted) so agents can read an object's queryable custom metadata by key — same as `uploads meta get`.
- dd84103: Multi-file `put` (CLI + stdio MCP) with partial failures; MCP total-failure keeps structured `failures[]`

## 0.11.0

### Minor Changes

- 41fb17b: Anonymous, opt-out usage telemetry for the CLI and MCP server (command name, version, OS/arch, exit code, duration, optional error code — never paths or tokens). Opt out with `UPLOADS_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, or `uploads telemetry disable`.

  Also adds explicit opt-in diagnostic reports: `uploads report` and the MCP `report` tool can send a short message plus an optional text log/trace (max 256 KiB) when the user asks — never automatic.

- 456f9f6: `uploads install` now installs two agent skills: the new `github-screenshots`
  workflow skill (when and how to get screenshots, GIFs, and recordings into
  GitHub PRs and issues) alongside the existing `uploads-cli` CLI reference.
  Skill steps are reported separately in human and `--json` output.

### Patch Changes

- 1f611f4: Make `uploads usage` human-readable: formatted sizes/counts, local-timezone timestamps, and terminal progress bars (with web-matching % and high/full thresholds). Also shortens the first-run telemetry notice to a brief non-PII opt-out FYI.

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
