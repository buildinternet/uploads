# Releasing `@buildinternet/uploads`

The CLI is published from `.github/workflows/release.yml` using npm trusted publishing, without a long-lived npm token. Version `0.1.0` is already published and the trusted publisher is configured; do not manually publish later releases.

## Trusted-publishing configuration

The npm package is configured with a GitHub Actions trusted publisher for organization `buildinternet`, repository `uploads`, workflow `release.yml`, no environment, and allowed action `npm publish`. No `NPM_TOKEN` GitHub secret is needed.

Keep maintainer 2FA enabled. The workflow pins npm 11.18.0 because trusted publishing requires npm 11.5.1 or newer and Node 22.14 or newer.

## Release

1. From `packages/uploads`, choose the next semantic version and update the manifest without creating a tag:

   ```bash
   npm version 0.2.0 --no-git-tag-version
   ```

2. Run the package tests and tarball check, then open a PR containing the version change. Merge it to `main` before tagging.
3. Update local `main`, verify `packages/uploads/package.json` contains the intended version, and tag that exact merge commit:

   ```bash
   git tag uploads-v0.2.0
   git push origin uploads-v0.2.0
   ```

4. Confirm the **Release npm package** workflow succeeds, then verify the new version and provenance on npm.

The tag must be new and must exactly match the package version; never move or reuse a release tag. The workflow rejects mismatches and npm rejects versions that are already published.
