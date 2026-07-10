# Releasing `@buildinternet/uploads`

The CLI is published from `.github/workflows/release.yml` using npm trusted publishing, without a long-lived npm token.

## One-time npm setup

1. Create or claim the `@buildinternet` npm organization and ensure the maintainer can publish `@buildinternet/uploads`.
2. In npm package settings, add a GitHub Actions trusted publisher for organization `buildinternet`, repository `uploads`, workflow `release.yml`, with no environment. Select `npm publish` as the allowed action.
3. Keep maintainer 2FA enabled. No `NPM_TOKEN` GitHub secret is needed. The workflow pins npm 11.18.0 because trusted publishing requires npm 11.5.1 or newer and Node 22.14 or newer.

A first publication may need to be manual before npm allows configuring the trusted publisher. Run the build and `pack:check`, publish once from `packages/uploads` with a maintainer account, then configure trusted publishing immediately.

## Release

1. Update `packages/uploads/package.json` to the intended semver version and merge to `main`.
2. Push a matching tag, such as `uploads-v0.2.0` for package version `0.2.0`.
3. Confirm the **Release npm package** workflow succeeds and verify npm.

The workflow rejects a tag that does not exactly match the package version. Provenance is enabled in the manifest and publish command.
