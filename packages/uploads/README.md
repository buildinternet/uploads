# @buildinternet/uploads

CLI and client for **uploads.sh** — upload files, get public URLs, and produce GitHub-ready markdown.

## CLI

Binary: **`uploads`**. Install globally (or use an `npx` one-shot):

```bash
npm install --global @buildinternet/uploads
npx @buildinternet/uploads --help
```

```bash
uploads setup
uploads --version
uploads attach ./before.png ./after.png
uploads put ./shot.png
uploads put ./shot.png --destination screenshots
uploads put ./shot.png --no-optimize
uploads put ./mobile.png --frame phone
uploads put ./ui.png --frame browser --frame-url "https://app.example"
uploads put ./after.png --pr 123 --comment
uploads gallery create --title "Release screenshots"
uploads put ./after.png --gallery gal_example
uploads doctor
```

Inside this monorepo only, `pnpm uploads …` builds the package first so you pick
up local source; product docs and PR “how to try it” examples should use the
global `uploads` form above.

Commands: `attach`, `put`, `gallery`, `comment`, `list`, `delete`, `usage`, `reconcile`,
`purge-expired`, `setup`, `install`, `config`, `doctor`, `health`, `mcp`.

**Globals (before the command):** `--api-url`, `--token`, `--workspace` / `-w`,
`--env-file`, `--json`, `--quiet`, `--version` / `-V`, `-h` / `--help`.

**Update hints:** after a successful run the CLI may print one stderr line when a
newer npm release is available (at most once/day, `~/.cache/uploads/`). Silence
with `--quiet`, `--json`, `UPLOADS_NO_UPDATE=1`, or `NO_UPDATE_NOTIFIER=1`. Not used
for `uploads mcp`.

`attach` is the agent-friendly default for GitHub media. It accepts one or more files,
infers the pull request for the current branch via `gh`, uploads stable URLs, and creates
or updates one managed attachments comment. Use `--pr`, `--issue`, and `--repo` to select
the target explicitly, or `--no-comment` to upload without changing GitHub comments.

**Keys / destinations:** default put uses the `screenshots` layout. Typed destinations
(`--destination screenshots|gh|f`, MCP `destination`) set the root; `--pr`/`--issue`
use `gh/…`. Workspaces may restrict put/sign to those roots via
`allowedKeyPrefixes` (see [workspaces](../../docs/workspaces.md)).

**Image optimization:** by default, still images are re-encoded to WebP (long edge
capped, high quality) before upload so GitHub embeds stay small, and **EXIF is
stripped**. Pass `--keep-exif` / `UPLOADS_KEEP_EXIF=1` to preserve image metadata, or
`--no-optimize` / `UPLOADS_NO_OPTIMIZE=1` to upload originals unchanged.

**Frames (opt-in):** `--frame phone|browser|iphone-16-pro` composites chrome
**before** optimize. `phone`/`browser` are procedural; `iphone-16-pro` fetches
community art from [device-frames-media](https://github.com/jonnyjackson26/device-frames-media)
into `~/.cache/uploads/frames` (not bundled).

## Public galleries

Create an ordered gallery, then add existing uploads by key. The API returns the canonical
public URL; the CLI never constructs it. **Anyone who knows that URL can view the gallery and
its media**—GitHub or repository visibility does not restrict it. Deleting a gallery removes
only the gallery record, not its uploaded objects or their retention policy.

```bash
uploads gallery create --title "Release screenshots"
uploads gallery add gal_example screenshots/myapp/42/after.webp --alt "Updated dashboard"
uploads put ./before.png --gallery gal_example
uploads gallery show gal_example
uploads gallery link gal_example --github buildinternet/uploads#58
uploads gallery list --github https://github.com/buildinternet/uploads/pull/58
```

When adding several keys, `uploads gallery add` processes them sequentially and reports any
individual failures in `--json` output. Gallery item updates use the API's current version to
avoid overwriting concurrent changes.

Link a gallery to a GitHub issue or pull request with `gallery link --github`. Coordinates and strict `https://github.com/<owner>/<repo>/issues|pull/<number>` URLs are accepted; `gallery list --github` performs the authenticated reverse lookup. Links never change gallery identity, and GitHub repository visibility does not make the public gallery private.

Config layers (first match wins): CLI flags → env vars → `--env-file` → `~/.config/buildinternet/config`. See `config.example` for keys.

## MCP server

`uploads mcp` serves the Model Context Protocol over stdio (newline-delimited JSON-RPC, no extra dependencies). Tools include file operations plus public gallery workflows: `gallery_create`, `gallery_get`, `gallery_add`, `gallery_link`, and `gallery_find_by_reference`. Gallery tools return API-provided canonical URLs and never need GitHub credentials. The remaining stdio tools are `put`, `attach`, `list`, `delete`, `usage`, `reconcile`, `purge_expired`, `comment`, `health`, and `doctor` — with the same config resolution and defaults, plus a per-call `workspace` argument. Interactive/credential commands (`setup`, `login`, `admin`, `config`) are not exposed. A token isn't required to start the server; auth errors surface per tool call (`health` needs no auth).

```json
{ "command": "uploads", "args": ["--env-file", "/path/to/.env", "mcp"] }
```

Or with `UPLOADS_TOKEN`/`UPLOADS_WORKSPACE` in the environment or user config. Claude Code: `claude mcp add uploads -- uploads --env-file /path/to/.env mcp`.

For HTTP clients there's also a hosted variant at `https://agents.uploads.sh/mcp` — the workspace is inferred from the bearer token, so only the URL and token are needed (`https://agents.uploads.sh/<workspace>/mcp` and the `mcp.uploads.sh` hostname also work). Tools: file operations plus `gallery_create`, `gallery_get`, `gallery_add`, `gallery_link`, and `gallery_find_by_reference`; all use the same bearer-token workspace scopes and gallery URLs come from the API — see `apps/mcp` in the repo. `uploads install` registers it with Claude Code (and installs the agent skill) in one step. Its `put` takes no content type: the stored type is sniffed server-side from the bytes and checked against the workspace allowlist, and writes are rate limited per workspace.

## Programmatic use

```ts
import { createUploadsClient } from "@buildinternet/uploads";
```

Agent/MCP helpers: `@buildinternet/uploads/agent` (`createUploadsWorkerFileTools` for Workers); for local stdio MCP, use `uploads mcp` (above).

## Layout

```
src/
  cli.ts              Entry + help
  package-version.ts  Shared version for --version / doctor / headers
  update-check.ts     Optional npm update hint (stderr)
  commands.ts         put, list, delete, comment, …
  commands/mcp.ts     `mcp` command entry
  mcp/                Stdio MCP server (server.ts, tools.ts)
  client.ts           HTTP client for the API
  github.ts           PR/issue key paths + attachment comments
  embed.ts            Markdown image output
bin/uploads.js        Bin shim
```

## Commands

```bash
pnpm build        # tsc → dist/
pnpm typecheck
pnpm test
pnpm pack:check   # verify the npm tarball contents
```

Maintainer release instructions: [`docs/releasing.md`](../../docs/releasing.md).

Agent-oriented usage: [`skills/uploads-cli/SKILL.md`](../../skills/uploads-cli/SKILL.md). REST details: [`docs/api.md`](../../docs/api.md).
