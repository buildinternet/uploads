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
cause or prove startup reliability. Repeated startup and the visible icon
still require verification.

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
The automated browser again failed to display the sandbox document. The user
then manually reloaded the fresh test conversation and supplied a screenshot:
the panel rendered Staged with zero files and Attached for PR #1298 with six
files. The trusted-scope error was absent. The panel title still displayed the
generic icon, so embedding the tool icon did not fix the visible branding.

[Fresh host panel with six attached files](https://embed.uploads.sh/default/gh/buildinternet/uploads/pull/1298/fresh-host-attached-generic-icon.webp)

The installed personal plugin's manifest has neither `logo` nor `composerIcon`.
A branding update package includes both fields and the canonical 512 px PNG,
with the same registered app mapping. The user applied this personal test
package as version 1.0.1. Its plugin listing now displays the Uploads artwork.
The registered app row and a newly opened conversation panel still display
generic icons. The package update therefore fixes listing branding only;
it does not resolve the panel-header icon. No directory submission was made.

- [Branded personal-plugin listing](https://embed.uploads.sh/default/gh/buildinternet/uploads/pull/1298/branded-plugin-listing.webp)
- [Generic panel header after the package update](https://embed.uploads.sh/default/gh/buildinternet/uploads/pull/1298/branded-plugin-generic-panel-header.webp)

The opener advertises `icons` in `tools/list`, which is the highest-priority
entrypoint icon source in the [OpenAI extensions specification](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#entrypoint-icons).
The generic header remains a host integration issue to investigate; these
observations do not establish where the host loses or ignores that metadata.

The legacy catalog guard deployed only to `uploads-mcp` as version
`ff2c7a0e-f336-45e5-b55e-8451f88cf688`. The resource regression failed against
the previous handler, then all 194 MCP tests passed with the fix. Both
typechecks passed. Live reads confirmed that only the legacy resource carries
the catalog marker, and attached-file pagination still works on the endpoint.

The user completed a manual startup smoke check: one reload of the working
ChatGPT conversation, followed by two panel close/reopens. Files loaded each
time without a persistent blank panel. The generic header icon is deferred.

## Image previews

Click an available image in either section to open a larger preview inside the
panel. The preview fits the panel by default. Choose Actual size to inspect
details and scroll around the image; Fit to panel returns to the fitted view.
Escape, the backdrop, and the close button return to the file list and restore
focus to the thumbnail. Private, held, missing, and unsupported items remain
placeholders. Video controls keep their existing behavior.

Local browser checks covered both sections, keyboard opening, actual-size
overflow, Escape, backdrop close, focus return, and the 439 px panel layout.
The UI build, both typechecks, and all 194 hosted MCP tests passed.

The first host check after deployment still showed plain images with no preview
buttons. The host retained the prior UI at the reused v2 resource address.
The opener now advertises `ui://uploads/media-v3.html` so refreshed discovery
loads a distinct document. V2 remains an unguarded compatibility alias; V1
retains its original-tool restriction. Existing pinned chats still require a
connection refresh and a new conversation. All three resource addresses have
authenticated read-scope coverage. Available thumbnails now display View larger.

- [Wide image preview](https://embed.uploads.sh/default/gh/buildinternet/uploads/pull/1298/image-preview-wide.webp)
- [Narrow fitted image](https://embed.uploads.sh/default/gh/buildinternet/uploads/pull/1298/image-preview-narrow-fit.webp)
- [Narrow actual-size image](https://embed.uploads.sh/default/gh/buildinternet/uploads/pull/1298/image-preview-narrow-actual.webp)

## Build identities and compatibility

The UI build computes SHA-256 from the final bundled HTML, including its
inlined JavaScript and CSS. The opener advertises
`ui://uploads/media/c1/<sha256>.html`. Identical builds keep the same address;
changed HTML produces a different address without a manual version bump.

`c1` is a compatibility family, not a build counter. Its UI may call only
`list_staged_scopes`, `list_staged_media`, `resolve_media_context`, and
`list_attached_media`. A new UI tool call can break an older chat's trusted
catalog even when the server API change is additive. Such a change needs a
new family and a retained implementation or capability guard for old families.

Older valid hashes within `c1` resolve to the latest compatible HTML and echo
the requested resource URI. They are compatibility aliases, not an immutable
archive of historical bundles. Resource metadata reports the actual served
HTML's hash in `uploads.sh/uiBuildHash` and its family in
`uploads.sh/uiCompatibility`. Unknown families and malformed hashes reject.
All resource reads retain the existing authenticated `files:read` gate.

The original `staged-media-v1.html`, `media-v2.html`, and `media-v3.html`
addresses remain readable. V1 retains its staged-only tool guard. V2 and V3
serve the modern compatible UI. The V1 response reports the hash of its
guarded HTML rather than the unmodified modern bundle.

New resource addresses invalidate UI cache entries after discovery refresh;
they do not replace a document already open in a chat. Published resource
reference changes also pass through OpenAI's continuous tool review. See the
[UI update requirements](https://developers.openai.com/plugins/deploy/app-review#other-changes).
