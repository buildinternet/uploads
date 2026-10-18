# Releasing `@buildinternet/uploads`

The CLI/client package is published with **changesets** + npm **trusted
publishing** (OIDC — no long-lived `NPM_TOKEN`). The **Release** workflow on
`main` cuts the published versions.

## Trusted-publishing configuration

On npmjs.com the package needs a GitHub Actions trusted publisher for:

- Organization: `buildinternet`
- Repository: `uploads`
- Workflow: **`release.yml`**
- No environment
- Allowed action: `npm publish`

Keep maintainer 2FA enabled. The workflow pins npm 11.18.0 (trusted publishing
requires npm ≥ 11.5.1 and Node ≥ 22.14).

## Day-to-day (feature PRs)

1. Make user-visible changes under `packages/uploads` (and keep
   `skills/uploads-cli` in sync when commands change).
2. Add a changeset:

   ```bash
   pnpm changeset
   # or write .changeset/<slug>.md by hand
   ```

   Header names the package that actually changed. Two valid targets:

   ```md
   ---
   "@buildinternet/uploads": minor
   ---

   User-facing description.
   ```

   ```md
   ---
   "@uploads/plugin": patch
   ---

   Why existing plugin installs must pick this up.
   ```

3. Merge the feature PR to `main` (with the `.changeset/*.md` file).

**Never hand-edit** `packages/uploads/package.json` or
`packages/plugin/package.json` `version` — `changeset version` owns them.

Changesets ignore the other private packages (`@uploads/api`, `@uploads/mcp`,
…). They deploy via Workers Builds. `@uploads/plugin` is the exception: it is
versioned, not published.

## Cut a release

1. After one or more feature PRs land with pending changesets, the **Release**
   workflow opens or updates a **`chore: version packages`** PR. That PR runs
   `changeset version`: bumps the version, writes
   `packages/uploads/CHANGELOG.md`, and removes consumed changeset files.
2. Review and merge the version PR.
3. The same workflow re-runs on `main` with **no pending changesets**, then:
   - tests / builds / pack-checks the package
   - runs `changeset publish` (OIDC provenance)
   - creates a GitHub release tagged `uploads-v<version>` (same prefix as before)
   - publishes `server.json` to the [MCP Registry](https://registry.modelcontextprotocol.io)
     as `sh.uploads/mcp`

Verify the version and provenance on npm after the workflow succeeds. Confirm
the MCP listing with:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=sh.uploads/mcp"
```

## MCP Registry

The registry stores metadata only. It checks that the published npm package
declares `mcpName` equal to `server.json` `name`, then records how clients
run the server: stdio via `uploads mcp`, and the hosted remote at
`https://agents.uploads.sh/mcp`.

The listing name is the reverse-DNS of uploads.sh: `sh.uploads/mcp`. That
string must match `mcpName` on `@buildinternet/uploads`. A registry publish
always follows an npm publish of that version.

`changeset version` copies the new package version into `server.json` so the
version PR shows the stamp. The publish job stamps again before
`mcp-publisher publish`. CI runs `pnpm server-json:check` on every pull
request so `name`, `mcpName`, and the two version fields cannot drift.

Publish authenticates with HTTP domain proof, not GitHub OIDC. The public
record is `https://uploads.sh/.well-known/mcp-registry-auth` (served from
`apps/web/public/.well-known/mcp-registry-auth`). Prefer the
`MCP_REGISTRY_PRIVATE_KEY_PEM` Actions secret (PEM). The job still accepts the
legacy hex secret `MCP_PRIVATE_KEY`. The publish job runs
`mcp-publisher login http --domain uploads.sh`. That grant is `sh.uploads/*`.

`changeset version` also regenerates
`apps/web/public/.well-known/mcp/server-card.json` from `server.json`. The
hosted worker advertises the same CLI version in `serverInfo`, not
`apps/mcp`'s private `package.json`.

Do not change `server.json` `name` or `packages/uploads` `mcpName` without a
matching npm publish. The registry treats those strings as the server's
identity.

## Plugin version (Claude / Codex)

The Claude/Codex plugin version is **not** the CLI version. Claude caches
installs under `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`.
A change that must reach existing installs (manifest, hooks, skills) needs a
changeset for `@uploads/plugin`:

```md
---
"@uploads/plugin": patch
---

Why existing installs must pick this up.
```

`changeset version` bumps `packages/plugin` and copies the number into
`plugin.json`, `plugins/claude/uploads/.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`, and `.codex-plugin/plugin.json`. CI runs
`pnpm plugin-version:check` so those files cannot drift. A plugin-only
version PR does not publish to npm; the MCP Registry listing still follows
the CLI version via `server.json`.

After the version PR lands on `main`, existing installs need
`/plugin marketplace update` then `/plugin update uploads@uploads` (or
uninstall and install).

## Claude directory

uploads has two listings in the Claude directory. Each updates in its own
way. Both are managed at [claude.ai/directory/manage](https://claude.ai/directory/manage)
under **Submissions**.

| Listing                                                                  | What it lists                      | How it updates                                                        |
| :----------------------------------------------------------------------- | :--------------------------------- | :-------------------------------------------------------------------- |
| Plugin `uploads.sh`                                                      | `plugins/claude/uploads` on `main` | From the repo: each new commit to that folder is a new version        |
| Connector `Uploads` ([public page](https://claude.ai/directory/uploads)) | `https://agents.uploads.sh/mcp`    | Only in the portal: edit the listing, then submit the edit for review |

### Plugin versions

The directory follows `main` and reads only `plugins/claude/uploads`. It
picks up a new commit to that folder on a schedule, or at once when you
select **Check for new commits** on the plugin's page. It then validates the
folder and runs a security scan. A version that passes waits for **Publish**,
and a reviewer then publishes it. The plugin's **Versions** tab shows each
scanned commit and its result.

Rules that follow from this:

- **A merge is not a release.** The listing serves the last published version
  until a newer one is published. A version that fails the scan, or is held
  for a reviewer, leaves the live version in place. After a failed scan,
  later versions also wait for a reviewer.
- **Raise the version for every release.** Use the `@uploads/plugin` changeset
  described in [Plugin version](#plugin-version-claude--codex).
- **Listing text comes from the plugin.** The display name and short
  description follow `plugin.json` in the live version. The long description
  is `plugins/claude/uploads/README.md`. The portal's **Listing** tab is
  read-only.
- **Describe what the plugin runs.** The security scan compares behavior with
  the README. A new hook or mod that runs a command or calls a service needs a
  line in the plugin README's data and network access section.
- **Expect a reviewer hold for code.** The plugin is a subfolder of the
  repository, so a hook or mod that runs a non-shell file (such as
  `hooks/register.tsx`) is held as **Scripts the validator couldn't follow**.
  A hold delays publishing; it is not a rejection.

Before a change to the plugin folder lands, check it:

```bash
claude plugin validate --strict plugins/claude/uploads
claude plugin test plugins/claude/uploads    # the mod's tests
```

The portal runs more checks than the CLI. To run them on a branch before it
merges, start **Submit new** → **Plugin bundle**, enter
`buildinternet/uploads@<branch>` with plugin path `plugins/claude/uploads`,
select **Validate**, read the report, and leave without submitting.

### Users during a lag

Each channel updates on its own. For a short time they can disagree:

- **GitHub marketplace:** new installs get `main` at once. Existing installs
  update when the plugin version changes.
- **npm CLI:** CLI changes reach users when the version PR publishes.
- **Claude directory:** users keep the last published version until the next
  one is published. Docs that describe a new plugin feature are ahead of
  directory users until then.

## OpenAI directory

Build the directory ZIP with `pnpm plugin-directory:build`. The builder uses
the existing `@uploads/plugin` version and shared skills. It excludes local
hooks and Claude mods. CI validates the archive with
`pnpm plugin-directory:check`.

See [the submission runbook](../plugins/codex/directory.md) for reviewer
fixtures, importing the existing recording, OAuth checks, domain verification,
and the portal steps. Build a new ZIP for metadata or skill changes. Hosted
MCP tool updates go through OpenAI's server scans separately.

## Manual / recovery

```bash
pnpm changeset              # add a pending bump
pnpm run changeset:version  # apply pending → version + CHANGELOG + server.json (local only)
pnpm run changeset:publish  # npm publish packages that need it (needs auth)
```

Do not re-use or move a published version or release tag.

If the MCP Registry step fails after npm already published, re-run **Release**
with `mcp_registry_only` (Actions → Release → Run workflow). Republishing the
same version is a no-op. Or publish `server.json` locally:

```bash
brew install mcp-publisher
mcp-publisher login http --domain uploads.sh --private-key "$MCP_PRIVATE_KEY"
pnpm server-json:check
mcp-publisher validate
mcp-publisher publish
```
