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

   Header lists only the published package:

   ```md
   ---
   "@buildinternet/uploads": minor
   ---

   User-facing description.
   ```

3. Merge the feature PR to `main` (with the `.changeset/*.md` file).

**Never hand-edit** `packages/uploads/package.json` `version` for a release —
`changeset version` owns it.

Changesets ignore the private packages (`@uploads/api`, `@uploads/mcp`, …);
they deploy via Workers Builds.

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
declares `mcpName` equal to `server.json`'s `name`, then records how clients
should run the server: stdio via `uploads mcp`, and the hosted remote at
`https://agents.uploads.sh/mcp`.

The listing name is the reverse-DNS of uploads.sh: `sh.uploads/mcp`. `mcpName`
on `@buildinternet/uploads` must match. A registry publish always follows an
npm publish of that version. `changeset version` copies the new package version
into `server.json` so the version PR shows the stamp. The publish job stamps
again before `mcp-publisher publish`. CI runs `pnpm server-json:check` on
every pull request so `name`, `mcpName`, and the two version fields cannot
drift.

Publish authenticates with HTTP domain proof, not GitHub OIDC. The public
record is `https://uploads.sh/.well-known/mcp-registry-auth` (served from
`apps/web/public/.well-known/mcp-registry-auth`). The matching Ed25519
private key is the `MCP_PRIVATE_KEY` Actions secret (64-character hex). The
publish job runs `mcp-publisher login http --domain uploads.sh`. That grant
is `sh.uploads/*`.

The proof file has to be live on uploads.sh before the first registry
publish. Merge the change that adds the file, let the web worker deploy, then
merge the version PR.

Do not change `server.json` `name` or `packages/uploads` `mcpName` without a
matching npm publish. The registry treats those strings as the server's
identity.

## Manual / recovery

```bash
pnpm changeset              # add a pending bump
pnpm run changeset:version  # apply pending → version + CHANGELOG + server.json (local only)
pnpm run changeset:publish  # npm publish packages that need it (needs auth)
```

Do not re-use or move a published version or release tag.

If the MCP Registry step fails after npm already published, re-running the
Release workflow will not retry: `changeset publish` prints no new tag, so the
MCP step is skipped. Publish `server.json` locally instead:

```bash
brew install mcp-publisher
mcp-publisher login http --domain uploads.sh --private-key "$MCP_PRIVATE_KEY"
pnpm server-json:check
mcp-publisher validate
mcp-publisher publish
```
