# Contract testing

The product promise crosses the CLI, API, object storage, public CDN, and
GitHub. Unit tests cover local behavior; use these smoke checks to verify the
deployed boundaries without committing credentials.

## Read-only check

This is safe to run against production and requires no secret:

```bash
node scripts/smoke-contract.mjs
```

It verifies that the API is reachable and that `GET /health` still returns the
documented contract.

## Upload lifecycle

The lifecycle check creates a uniquely named text object, verifies the upload
response, metadata, listing, public URL bytes and content type, then deletes the
object. Cleanup runs even if an intermediate assertion fails.

```bash
UPLOADS_API_URL=https://api.uploads.sh \
UPLOADS_WORKSPACE=default \
UPLOADS_TOKEN=up_default_... \
node scripts/smoke-contract.mjs --lifecycle
```

Use a dedicated, revocable smoke-test token. Pass it through the environment,
not a command-line flag, and never commit it. The script prints no token or
public object URL.

## Full GitHub acceptance test

Run this manually in a disposable public repository before a CLI release. It
mutates a real PR and therefore is intentionally not part of the API script.

1. Install the exact package artifact or version being released.
2. Authenticate `gh` and create a disposable branch and PR.
3. Run `uploads setup --token <dedicated-token>` and `uploads doctor`.
4. Run `uploads attach before.png after.png` from the PR branch.
5. Confirm one managed comment contains both rendered images.
6. Replace `after.png`, rerun `uploads attach after.png`, and confirm the same
   comment and URL are updated rather than duplicated.
7. Confirm `uploads attach after.png --no-comment` uploads without changing the
   managed comment.
8. Repeat once with explicit `--pr <number>` and once with `--issue <number>`.
9. Verify a failed `gh` invocation does not lose the uploaded URL/Markdown and
   returns actionable machine-readable output with `--json`.
10. Delete the disposable attachments, close the PR/issue, and revoke the test
    token.

For a scheduled CI job, store only the dedicated upload token and GitHub token
as repository secrets, limit their scopes, use a single disposable repository,
and serialize runs to prevent comment races. Keep that job separate from pull
request CI so untrusted changes never receive the secrets.

## Remote MCP lifecycle

The manual **Remote MCP smoke** workflow exercises the deployed enrollment and
stateless MCP boundary. Protect its `remote-mcp-smoke` GitHub Environment with
required reviewers and restrict its deployment branches/tags to `main`. Store
`ADMIN_TOKEN` only as an environment secret, and configure `UPLOADS_API_URL` and
`UPLOADS_MCP_URL` as environment variables. Run it only against an existing
disposable workspace. The job also rejects non-`main` workflow refs before loading
the protected environment.

The test creates a five-minute, single-use enrollment and exchanges it for a
15-minute read/write/delete token. It then runs `initialize`, `tools/list`, put,
list, and delete before revoking the token and confirming it receives 401. Generated
credentials are masked immediately; response bodies, tokens, and public object URLs
are never printed. Object cleanup and token revocation run in `finally` blocks.
The workflow is manual-only and never exposes its administrator credential to pull
request code or routine agents.

## Release gate

A release is ready for the agent workflow when a clean environment can:

```bash
npx @buildinternet/uploads setup --token <token>
npx @buildinternet/uploads attach screenshot.png
```

Success means repository and current PR inference work, the public media
renders in one managed comment, reruns update rather than duplicate it, and all
failure modes retain the uploaded URL in structured output.
