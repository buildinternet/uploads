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
URLs. The panel previews public images and videos on `embed.uploads.sh`
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
TypeScript module with the HTML and build metadata for the Worker. Build hooks cover tests, typechecking,
development, and deployment. No database migration is required.

For fixture-only visual checks:

```sh
node apps/mcp/ui/dev.mjs
```

Open `http://127.0.0.1:4320/preview.html`. This preview uses synthetic responses
and does not validate live OAuth or the MCP host bridge. It is excluded from
the production HTML bundle.

## Image previews

Click View larger on an available image in either section to open a preview
inside the panel. It fits the panel by default. Actual size shows the image at
its natural dimensions and permits scrolling. Fit to panel restores the fitted
view. Escape, the backdrop, and the close button return to the file list and
restore focus to the thumbnail. Placeholders and video controls retain their
existing behavior.

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

## Validation and remaining coverage

The runtime from commit `644f321b` deployed only to `uploads-mcp` as version
`5eeadf82-ce8c-4a52-a344-3f3118c8649f`. No migrations or environment-file edits
were required. Validation completed on October 25, 2026:

- All 202 hosted MCP tests, both typechecks, UI build, lint/format, and CI passed.
  Tests cover read permissions, workspace/PR/cursor isolation, stale results,
  placeholders, and both MCP protocols.
- Identical full rebuilds produced identical HTML and resource modules. A known
  SHA-256 fixture and changed-content checks passed. The older-hash regression
  failed against the previous implementation and passed with compatibility routing.
- Live endpoint reads confirmed that the advertised hash matches the locally
  built and served HTML. Current and older hashes plus V1/V2/V3 references loaded.
  The V1 guard remained present. Malformed references and invalid bearer tokens
  rejected. These probes used the existing CLI workspace credential.
- A separate personal plugin connected through real ChatGPT OAuth with
  `files:read` and the normal `offline_access` session scope, using the `default`
  workspace. Real uploads stayed separate across two repositories and two
  branches. Staged and attached pagination, branch switching, Refresh, explicit
  empty scopes, PR resolution, and recovery passed.
- Local browser checks covered independent sections, slow scope changes,
  same-branch late PR results, mixed-case Git branches, private/held placeholders,
  image previews, keyboard opening, actual-size overflow, and the 439 px layout.
- A fresh ChatGPT web conversation after discovery refresh/reload rendered real
  attachments. Image opening, Actual size, Escape, and focus return passed.
  The user also confirmed one conversation reload and two panel close/reopens
  loaded Files each time without a persistent blank panel.

Automated initial sandbox delivery intermittently required a conversation
reload. Earlier tracing saw the widget fetch succeed, then the sandbox document
abort while browser instrumentation reported a paused document response. No
Uploads-code root cause was established; the manual smoke does not guarantee
startup reliability across all hosts.

The header icon remains generic despite the advertised tool icon and installed
personal-plugin branding. The plugin listing shows the Uploads artwork. The
header issue is explicitly deferred. Live private/held files, workspace
switching, insufficient/revoked grants, OAuth reconnection, and the full current
desktop-host matrix remain follow-up coverage; local fixtures do not prove them.

Selected evidence:

- [Live ChatGPT preview after the hash rollout](https://embed.uploads.sh/default/gh/buildinternet/uploads/pull/1298/live-hashed-image-preview.webp)
- [Live Staged and Attached sections](https://embed.uploads.sh/default/gh/buildinternet/uploads/pull/1298/fresh-host-attached-generic-icon.webp)
- [Narrow actual-size preview, local fixture](https://embed.uploads.sh/default/gh/buildinternet/uploads/pull/1298/image-preview-narrow-actual.webp)
- [Branded listing](https://embed.uploads.sh/default/gh/buildinternet/uploads/pull/1298/branded-plugin-listing.webp)

Submission packaging and reviewer-account validation remain separate work in
[PR #1059](https://github.com/buildinternet/uploads/pull/1059).
