# Read-only staged media tray

The hosted MCP server serves a tray for one repository and branch at a time.
The tray uses the shared Uploads React components and design tokens. It does
not upload, promote, unstage, delete, or change visibility.

## Scope

From a coding conversation, read the checkout's Git remote and current branch.
Pass them explicitly to `open_staged_media`:

```json
{ "repo": "owner/repository", "branch": "feature/settings" }
```

A global sidebar launch opens a picker without listing files. The picker lists
repository/branch pairs that have staged files. Users can also enter a pair.
Changing the selection clears the old files and discards late responses from
an earlier scope. Refresh reloads the selected branch and the branch choices.
It does not detect Git checkout changes. Call the opener with the new scope
when the coding agent changes branches.

Multiple branches never share a tray listing. Stored repository and branch tags
follow the existing staging normalization, including lowercase branch names.
Case-only branch names are therefore not distinct in the existing metadata.

## Auth and previews

The existing hosted MCP authentication selects the workspace. All tray reads
require `files:read`. Tool arguments cannot select another workspace.
The fixture server under `scripts/openai-ui-spike` remains synthetic and must
not receive live account credentials.

`list_staged_media` filters on `gh.repo`, `gh.kind=branch`, `gh.branch`, and
`gh.status=staged`. Results use object-key order. Load more follows a cursor
bound to the workspace and filters, including after an empty page.
`list_staged_scopes` returns distinct staged repository/branch pairs with its
own workspace-bound pagination.

The server checks storage visibility and review holds before returning preview
URLs. The first version previews public images and videos on `embed.uploads.sh`
and `storage.uploads.sh`. Private, held, missing, and unsupported-host files use
placeholders. BYO-host previews and private signed previews need a separate
resource CSP and authorization design.

## Build and verify

```sh
pnpm --filter @buildinternet/uploads run build
pnpm --filter @uploads/mcp run build:ui
pnpm --filter @uploads/mcp exec vitest run
pnpm --filter @uploads/mcp exec tsc --noEmit
pnpm --filter @uploads/mcp exec tsc --noEmit -p ui/tsconfig.json
```

The UI build embeds scripts, styles, and fonts in one HTML resource and emits a
TypeScript string module for the Worker. Build hooks cover tests, typechecking,
development, and deployment. No database migration is required.

For fixture-only visual checks:

```sh
node apps/mcp/ui/dev.mjs
```

Open `http://127.0.0.1:4320/preview.html`. This preview uses synthetic responses
and does not validate live OAuth or the MCP host bridge. It is excluded from
the production HTML bundle.

On October 25, 2026, local browser checks covered aligned branch selection at
390px, explicit repository changes, pagination, withheld placeholders, empty
and error states, and switching away from a slow branch request. Hosted MCP
and protocol tests cover scope permissions, tenant isolation, resources, and
both protocol versions. Production deployment and a live authenticated host
smoke test remain separate release steps. Earlier fixture host tests do not
prove that this new authenticated integration has been deployed.

Visual evidence from the fixture preview:

- [Narrow branch picker](https://embed.uploads.sh/default/gh/buildinternet/uploads/branch/codex-openai-ui-compatibility-spike/tray-branch-picker-narrow.webp)
- [Scoped tray](https://embed.uploads.sh/default/gh/buildinternet/uploads/branch/codex-openai-ui-compatibility-spike/tray-scoped-wide.webp)

## Test real uploads in the desktop app

These steps are still pending. The installed `Uploads UI Spike` plugin uses a
synthetic, unauthenticated endpoint. Do not add real workspace credentials to
that server or treat its successful host test as live-data validation.

1. Deploy this revision of the MCP worker to an approved authenticated target.
   The target must use the existing OAuth issuer, resource audience, workspace
   registry, and storage bindings. A branch push does not deploy this feature.
   No schema migration is needed. Do not expose an authenticated proxy through
   the fixture's no-auth tunnel.
2. Connect the real Uploads endpoint through OAuth in the desktop app with
   `files:read`. Refresh tool/resource discovery or create a separate personal
   test plugin so cached fixture metadata cannot mask the deployed catalog.
   Confirm `open_staged_media`, `list_staged_media`, and `list_staged_scopes`
   appear and that the UI resource loads.
3. In an authorized test workspace, stage harmless screenshots on two branches
   of the same repository. Use `uploads attach ./before.png --branch --state before`
   and `uploads attach ./after.png --branch --state after` from the intended
   checkout. Check each branch with `uploads staged`. Include another repository
   with the same branch name when testing repository isolation.
4. Open the tray from the desktop sidebar and the conversation panel separately.
   Select each repository/branch pair and verify it shows only that pair's staged
   files. Have the coding agent read its actual remote and branch and call the
   opener explicitly. A checkout change must not silently change Refresh's scope.
5. Verify pagination, a newly staged upload after Refresh, an empty branch,
   and files already promoted or unstaged. Confirm private and held test files
   remain placeholders. Check an authorized second workspace separately; the
   first workspace's files and cursors must not cross the connection boundary.
6. Check expired/revoked or insufficient-scope access reports an error rather
   than an empty tray. Reconnect through the normal OAuth flow and verify recovery.
7. Repeat cold opens, reloads, and panel reopenings. Record host build, latency,
   and failures. The earlier synthetic host intermittently failed to initialize;
   its root cause remains unresolved. Verify light/dark and narrow-panel behavior
   with the deployed bundle and capture fresh evidence without private data.

Directory packaging and identity-scope submission work remains in PR #1059.
That draft has conflicts with main and needs a separate refresh before submission.
