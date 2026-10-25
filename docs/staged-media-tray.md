# Uploads conversation panel

The hosted MCP server serves the Uploads conversation panel for one repository
and branch at a time. It shows separate Staged and Attached sections beside the
current thread, with no global sidebar entrypoint.
The tray uses the shared Uploads React components and design tokens. It does
not upload, promote, unstage, delete, or change visibility.

## Scope

From a coding conversation, read the checkout's Git remote and current branch.
Pass them explicitly to `open_staged_media`:

```json
{ "repo": "owner/repository", "branch": "feature/settings", "pr": 1298 }
```

A conversation-panel launch without an explicit scope opens a picker without
listing files. The picker lists
repository/branch pairs that have staged files. Users can also enter a pair.
Changing the selection clears the old files and discards late responses from
an earlier scope. Refresh reloads the selected branch and the branch choices.
It does not detect Git checkout changes. Call the opener with the new scope
when the coding agent changes branches.

Pass the current PR number when known. Otherwise, `resolve_media_context`
looks up the branch through the existing GitHub App only when the repository
is linked to the connected workspace. If it cannot resolve a unique PR, the
Attached section asks for a PR number. Staged files remain available.
The picker lists staged branch pairs; a branch with only attached files can
still be opened through explicit agent context or manual entry.

`list_attached_media` matches the selected workspace, repository, and PR using
`gh.kind=pull` and `gh.number`. It does not require a branch tag: direct PR
uploads do not always have one. Promotion removes a file from Staged and makes
its PR copy available in Attached. Both sections paginate independently and
use the same safe previews and private/held placeholders.

Multiple branches never share a tray listing. Stored repository and branch tags
follow the existing staging normalization, including lowercase branch names.
Case-only branch names are therefore not distinct in the existing metadata.

## Auth and previews

The existing hosted MCP authentication selects the workspace. All tray reads
require `files:read`. Tool arguments cannot select another workspace.
The earlier fixture remains synthetic and must not receive live credentials.
Its [compatibility results and archived source](openai-ui-compatibility.md)
are retained separately from the current tray preview.

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

The full desktop validation matrix below is still pending. The installed
`Uploads UI Spike` plugin uses a
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
4. Open the tray from the desktop conversation panel. Confirm that it has no
   global sidebar entrypoint.
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

The conversation-panel entrypoint advertises the existing pixelated triple-arrow
icon through the tool’s `icons` field. After deployment, refresh tool discovery
and verify the icon in the desktop conversation panel. See the
[entrypoint icon specification](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#entrypoint-icons).

## Live endpoint validation

On October 25, 2026, the conversation-only follow-up to merged PR #1296 was
deployed to `uploads-mcp` as version `90773919-ab7a-4714-a244-839ec6c12efd`.
The source base was `14e00ed6`. Live authenticated MCP reads confirmed:

- Tool discovery advertises only the `thread` entrypoint and the existing icon.
- The served UI resource matches the locally built HTML by SHA-256.
- Harmless uploads in the `default` workspace stay separate across two
  branches and two repositories that share a branch name.
- A two-page listing returns the same two files as `uploads staged`.
- An empty branch returns no items. An unscoped opener returns a scope picker.
- An invalid bearer token returns HTTP 401.

Successful requests took 81–351 ms in this single sequential probe. These
measurements cover endpoint responses, not host startup or rendering.
The endpoint probe used the existing CLI workspace credential. A separate
personal `Uploads staged media` plugin then connected through real ChatGPT web
OAuth with `files:read` and the normal `offline_access` session scope, after
user approval. The selected workspace was `default`.

The real conversation panel rendered the uploaded images beside the thread.
Branch switching, repository isolation, Refresh after staging a new image,
manual empty-branch selection, and recovery passed. The narrow panel switched
to one column at approximately 439 px. A warm close/reopen took 640 ms.
The global sidebar had no entrypoint for the real tray; the separate synthetic
spike retained its own entrypoint.

The first host load stayed blank and temporarily showed "This response
couldn’t load." Reloading the conversation and reopening its panel recovered
without a source change. The initial latency was not measured reliably.
Startup reliability remains unresolved. The host showed a generic icon for
the personal test plugin despite the correct tool icon metadata.
Native desktop automation was unavailable, so these host results cover ChatGPT
web, not the desktop app. Live private/held files, workspace switching,
insufficient/revoked grants, and OAuth reconnection remain unverified.

Visual evidence from the authenticated panel:

- [Conversation panel with real uploads](https://embed.uploads.sh/default/gh/buildinternet/uploads/branch/codex-staged-media-thread-panel/live-side-panel.webp)
- [Narrow conversation panel](https://embed.uploads.sh/default/gh/buildinternet/uploads/branch/codex-staged-media-thread-panel/live-narrow-panel.webp)

## Expanded panel validation

The follow-up deployment `e8f0bee3-36b7-4476-b438-204ff06422ed` adds the
Uploads title and separate Staged and Attached sections. The new resource is
`ui://uploads/media-v2.html`; the original v1 address remains readable for
cached entrypoints. Its compatibility mode permits only the original staged
read tools. The opener embeds the canonical PNG icon to avoid an
external icon fetch.

Live reads resolved the current branch to PR #1298 and returned one staged
file and five attached files. Attached pagination and wrong-PR/repository
exclusion passed. Local browser checks covered independent pagination,
placeholders, slow scope switching, late host results for another PR, and
Refresh with a mixed-case Git branch. All 194 hosted MCP tests passed.

The manually opened desktop v1 panel rendered real files. During automated
web cold-start tracing, ChatGPT's widget fetch returned HTTP 200 but the
sandbox document ended with `net::ERR_ABORTED`. Browser instrumentation also
reported a paused document response and blocked further tracing. This locates
the observed failure before app rendering; it does not establish a product-code
cause or prove startup reliability. Fresh v2 host rendering and the visible
icon still require verification after discovery refresh.

The user opened the expanded desktop panel and confirmed both sections rendered.
Attached failed with `MCP app cannot call tool outside its trusted tool scope:
list_attached_media`. This chat still advertised the old tool catalog, which
lacked both new read tools. The legacy resource had served the expanded UI
without accounting for that older catalog. The legacy resource now marks its
catalog version. Its client keeps staged reads working and shows refresh
instructions before attempting a new tool. It does not bypass the host's scope.

After a tool catalog changes, refresh the custom connection in ChatGPT's
Plugins settings, then start a new conversation. See OpenAI's
[metadata refresh instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata).
Refreshing the connection does not replace this existing chat's trusted catalog.
The new-conversation host test remains pending manual verification because the
automated browser again failed to display the sandbox document.

The legacy catalog guard deployed only to `uploads-mcp` as version
`ff2c7a0e-f336-45e5-b55e-8451f88cf688`. The resource regression failed against
the previous handler, then all 194 MCP tests passed with the fix. Both
typechecks passed. Live reads confirmed that only the legacy resource carries
the catalog marker, and attached-file pagination still works on the endpoint.
