# OpenAI directory submission

Build a portable package from the current Uploads sources. It includes the
production hosted MCP endpoint, canonical skills, and branding. It excludes
local hooks, Claude mods, registered personal-app mappings, and credentials.
Local Codex and Claude installations keep their existing hook behavior.

## Build the package

```sh
pnpm plugin-directory:check
pnpm plugin-directory:build
```

The ZIP is `dist/plugins/uploads-openai-<plugin-version>.zip`. The builder reads
identity and version from the root manifest and `packages/plugin`, listing
metadata from the Codex interface plus [directory-interface.json](directory-interface.json),
the endpoint from `.mcp.json`, and public content from `skills/` and
`assets/logo.png`. It rejects symlinks, hidden skill files, MCP headers, and
version drift. ZIP paths, permissions, and timestamps are normalized so
identical inputs produce identical archives. CI runs the same check.

The exported root `plugin.json` places OpenAI listing and review fields under
`extensions.com.openai`. `mcp.json` declares the production HTTPS endpoint;
OAuth credentials are configured through the portal. The ZIP has no hooks or
`.app.json`. No plugin version is hand-edited: release it through changesets.

## Prepare review fixtures

Use a dedicated reviewer account and workspace. Sign-in must work without
email/SMS codes, magic links, MFA approval, or private-network access, so the
reviewer signs in with email and password. There is no password sign-up: an
operator prepares the account once.

1. Invite a reviewer mailbox you control to the review workspace.
2. Accept the invitation with a magic link. This verifies the email.
3. On Account → Profile, choose **set a password by email** and open the link.
4. Sign out, then confirm **Use a password** on `/login` reaches the account,
   and through it the OpenAI OAuth consent.

Store the email, password, and these sign-in instructions only in the portal's
private Review details.

Prepare a harmless, public fixture repository and pull request. Install and
link the Uploads GitHub App so the reviewer can post a managed attachments
comment. Use a separate staging branch with no open PR, because uploads to a
branch with an open PR can attach automatically. Public PNG fixtures must
contain no real credentials or personal data.

Run the canonical [five positive and three negative cases](review-cases.json)
through OpenAI with that account. Include a real ChatGPT file attachment and
the staged/attached conversation panel. Confirm that available images open in
the larger preview, while private and held files remain placeholders. A safe
GitHub authorization decline is valid behavior but does not demonstrate the
prepared positive comment case; repair the fixture permissions before review.

Record the walkthrough and provide a reviewer-accessible HTTPS URL. To import
the cases and recording, create a local JSON file with public fixture details:

```json
{
  "repo": "owner/review-fixtures",
  "pullRequest": 1,
  "branch": "openai-review-staging",
  "beforePngUrl": "https://public-fixture-host.example/before.png",
  "afterPngUrl": "https://public-fixture-host.example/after.png",
  "demoRecordingUrl": "https://public-recording-host.example/walkthrough"
}
```

Replace every example value, then build:

```sh
pnpm plugin-directory:build --review-config /absolute/path/to/review.json
```

The builder accepts only those public fields. Cases are templates until this
configuration is supplied. A default build is a valid draft package, not a
claim that reviewer cases or a recording have been completed.

## Validate production and submit

After the code is reviewed and deployed, use a fresh OAuth client to validate
OIDC discovery, optional `openid`/`email`, truthful UserInfo verification,
consent, refresh, and the selected workspace. Existing clients retain their
registered scope ceilings. A personal `files:read` connection does not prove
these identity or reviewer-account requirements. Identity-only grants must
not gain file authority.

The UI resource declares its dedicated origin through `_meta.ui.domain`.
Refresh discovery and test fresh and older resource references in the host
after deployment. Content hashes identify builds; compatibility routing keeps
older references readable. See [the panel contract](../../docs/staged-media-tray.md).

Upload the complete ZIP to the [OpenAI plugin portal](https://platform.openai.com/plugins)
as a plugin **with MCP**. The publisher needs verified identity and Apps
Management write access. Inspect the imported listing, skills, MCP endpoint,
review cases, and recording. Free and paid Uploads accounts use their normal
workspace limits; the plugin does not initiate checkout or subscriptions.

When the portal issues a domain challenge, the operator sets its exact value
as `OPENAI_APPS_CHALLENGE` on the MCP worker. The route already exists at
`/.well-known/openai-apps-challenge`. Do not replace another plugin's challenge
or claim verification from the route's existence. Credentials and challenge
values stay outside the public ZIP and source tree.

Resolve required scans and configuration findings before submitting the draft.
Submission, policy attestations, and later publication are separate operator
actions. Follow the current [submission requirements](https://developers.openai.com/plugins/deploy/submission)
and [OAuth domain protections](https://developers.openai.com/plugins/build/auth#support-workspace-domain-restrictions).
