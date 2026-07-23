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

Verify the version and provenance on npm after the workflow succeeds.

## Manual / recovery

```bash
pnpm changeset              # add a pending bump
pnpm run changeset:version  # apply pending → version + CHANGELOG (local only)
pnpm run changeset:publish  # npm publish packages that need it (needs auth)
```

Do not re-use or move a published version or release tag.
