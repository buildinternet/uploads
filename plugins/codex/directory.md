# OpenAI directory submission

Reuse the Claude reviewer account, fixture repository, and recording if
they exercise the same hosted workflows. Run the cases again through OpenAI
before submitting. A Claude review does not verify ChatGPT file transfer,
OAuth consent, or tool approvals.

Follow the [submission guide](https://developers.openai.com/plugins/deploy/submission).
The publisher needs identity verification and permission to submit plugins.

## Build the draft

```bash
pnpm plugin-directory:check
pnpm plugin-directory:build
```

Upload `dist/plugins/uploads-openai-<plugin-version>.zip` in the
[OpenAI plugin portal](https://platform.openai.com/plugins). Connect the
declared `https://agents.uploads.sh/mcp` server using OAuth. Do not create a
skills-only submission: OpenAI cannot currently add MCP to an existing
skills-only plugin.

The ZIP contains the shared skills, logo, policy URLs, and listing prompts.
It excludes hooks and Claude mods. The CLI remains optional. Free and paid
accounts use the hosted tools subject to their workspace limits. Do not add
subscription checkout or upgrade promotion to the plugin.

## Reuse review materials

The five positive and three negative cases in
[review-cases.json](review-cases.json) adapt the existing
[submission cases](submission.md). Positive PR cases require a successful
managed comment. An authorization decline is a fixture error, not a pass.

To import those cases and a recording into the ZIP, create a local JSON file
with public fixture details. Replace every example value before using it:

```json
{
  "repo": "owner/review-fixtures",
  "pullRequest": 1,
  "branch": "openai-review-staging",
  "beforePngUrl": "https://your-public-fixture-host.example/before.png",
  "afterPngUrl": "https://your-public-fixture-host.example/after.png",
  "demoRecordingUrl": "https://your-accessible-recording-url.example/walkthrough"
}
```

```bash
pnpm plugin-directory:build --review-config /absolute/path/to/review.json
```

The builder fills the repository, PR, and branch into the prompts and includes
the public PNG URLs as review attachments. Fetch both URLs before submitting
and confirm they return the intended PNGs without sign-in. It includes
the recording under `extensions.com.openai.review`. Without this file, it
omits review metadata; enter it in the portal instead. Credentials belong in
the portal's private Review details, never in the JSON file or ZIP. The builder
rejects additional config fields, including credentials.

Prepare the reviewer workspace:

1. Use a dedicated account and sample data. A free workspace is sufficient
   for the small PNG cases.
2. Link the account to GitHub. Install the uploads.sh GitHub App on the fixture
   repository and confirm the reviewer can write to it.
3. Prepare one open fixture PR and a separate branch with no open PR.
4. Provide two small PNGs for before and after. Use synthetic credentials in
   the secret-redaction case, never real keys.
5. Provide an object in a separate inaccessible workspace for the isolation
   case and an inaccessible repository for the unauthorized-comment case.
6. Confirm sign-in works without magic links, email or SMS codes, inaccessible
   MFA, or private-network access. Reuse the Claude setup only if it meets this
   requirement.
7. Run all cases in order through OpenAI. Record actual outputs, public-file
   fetches, and comment URLs. Demonstrate the results in an accessible video.

Check a real ChatGPT attachment against the hosted `put` contract. Do not treat
guessed base64 or an inaccessible attachment URL as a successful upload. Do
not claim local capture or annotation works on a surface without a shell.

## Connect and verify

After the portal issues a domain challenge, set `OPENAI_APPS_CHALLENGE` on
`uploads-mcp` through Wrangler secrets. The existing endpoint returns only
that token at `https://agents.uploads.sh/.well-known/openai-apps-challenge`.

The authorization server advertises `openid` and `email` and uses Better Auth's
built-in discovery and UserInfo endpoint. UserInfo returns the user's actual
email verification status; never force `email_verified` to true. Use a
verified reviewer account and a newly registered OpenAI OAuth client.
Existing clients retain their persisted scope ceilings. This change does not
silently add identity scopes to existing grants or tokens.

After deploying the auth change, check discovery, PKCE, consent, refresh, and
UserInfo through the portal's actual client. Resolve required connection,
metadata, skill, and tool scan errors. Check the scanned safety hints against
each tool's behavior. OpenAI no longer requires annotation justifications.

## Submit and publish

Check the imported metadata, cases, video, and release notes. Enter the reviewer
login URL, private credentials, workspace, and instructions in Review details.
Complete the policy attestations and submit the selected draft.

Approval and publication are separate. Publish the approved version when it
should become available. Keep the reviewer account and fixtures available for
later reviews. Upload a new ZIP for skill or listing changes. Hosted tool
updates go through OpenAI's server scans.
