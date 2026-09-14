# Changesets

Pending version bumps for **`@buildinternet/uploads`** (npm CLI) and
**`@uploads/plugin`** (Claude / Codex plugin, not published).

## Adding a changeset

Any PR that changes user-visible CLI, client, or MCP behavior should add a file here:

```bash
pnpm changeset
```

Or write `.changeset/<slug>.md` by hand. Two valid headers:

```md
---
"@buildinternet/uploads": minor
---

Short, user-facing description of the change.
```

```md
---
"@uploads/plugin": patch
---

Why existing plugin installs must pick this up.
```

Bump levels: `patch` (fixes), `minor` (additive features), `major` (breaking).

Every other private workspace package (`@uploads/api`, `@uploads/mcp`, …) is
ignored — they deploy via Workers Builds, not npm. Do not name them in a
changeset.

## Release flow

1. Merge feature PRs (with changesets) to `main`.
2. The **Release** workflow opens or updates a `chore: version packages` PR (`changeset version` + changelog).
3. Merge that PR → workflow publishes `@buildinternet/uploads` to npm with OIDC provenance (no `NPM_TOKEN`).

Never hand-edit `packages/uploads/package.json` or `packages/plugin/package.json`
`version` — let changesets own them.
