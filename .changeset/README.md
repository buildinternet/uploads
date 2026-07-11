# Changesets

Pending version bumps for the published npm package **`@buildinternet/uploads`**.

## Adding a changeset

Any PR that changes user-visible CLI, client, or MCP behavior should add a file here:

```bash
pnpm changeset
```

Or write `.changeset/<slug>.md` by hand:

```md
---
"@buildinternet/uploads": minor
---

Short, user-facing description of the change.
```

Bump levels: `patch` (fixes), `minor` (additive features), `major` (breaking).

Private workspace packages (`@uploads/api`, `@uploads/mcp`, `@uploads/storage`, `@uploads/web`) are ignored — they deploy via Workers Builds, not npm.

## Release flow

1. Merge feature PRs (with changesets) to `main`.
2. The **Release** workflow opens or updates a `chore: version packages` PR (`changeset version` + changelog).
3. Merge that PR → workflow publishes `@buildinternet/uploads` to npm with OIDC provenance (no `NPM_TOKEN`).

Never hand-edit `packages/uploads/package.json` `version` for a release — let changesets own it.
