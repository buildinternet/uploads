# auth.md

Agent authentication for **uploads.sh** — invitation enrollment and workspace
bearer tokens (not browser OAuth / OIDC).

## Audience

Coding agents, CLI automation, and the hosted MCP server. Humans use the same
flow via `uploads login`. Routine agents never receive `ADMIN_TOKEN`.

## How agents get credentials

1. An uploads.sh administrator creates a short-lived, single-use invitation for
   an existing workspace (`uploads admin invite create`, optional `--email`).
2. Open the magic link (or receive the code out of band with `--separate-code`).
3. Exchange the code once:

```bash
npm install --global @buildinternet/uploads
uploads login
# non-interactive:
UPLOADS_ENROLLMENT_CODE=upe_… uploads login
```

4. On success the CLI writes `UPLOADS_API_URL`, `UPLOADS_WORKSPACE`, and
   `UPLOADS_TOKEN` to the shared buildinternet config and runs `uploads doctor`.
   The raw token is not printed.

Details: [enrollment docs](https://github.com/buildinternet/uploads/blob/main/docs/enrollment.md).

## Using the credential

Send the workspace token on every protected request:

```http
Authorization: Bearer up_<workspace>_…
```

| Scope          | Default on enrollment | Use                               |
| -------------- | --------------------- | --------------------------------- |
| `files:read`   | yes                   | list, metadata, usage             |
| `files:write`  | yes                   | upload, reconcile                 |
| `files:delete` | no                    | delete / purge (admin must grant) |

Tokens default to a 90-day lifetime. Hosted MCP at
`https://agents.uploads.sh/mcp` uses the same bearer scheme (workspace is
inferred from the `up_<workspace>_…` token form).

## Discovery documents

| Resource               | URL                                                            |
| ---------------------- | -------------------------------------------------------------- |
| This file              | https://uploads.sh/auth.md                                     |
| Agent summary          | https://uploads.sh/llms.txt                                    |
| API catalog (RFC 9727) | https://uploads.sh/.well-known/api-catalog                     |
| OpenAPI (summary)      | https://uploads.sh/.well-known/openapi.json                    |
| MCP server card        | https://uploads.sh/.well-known/mcp/server-card.json            |
| Agent skills index     | https://uploads.sh/.well-known/agent-skills/index.json         |
| Narrative API docs     | https://github.com/buildinternet/uploads/blob/main/docs/api.md |
| API health             | https://api.uploads.sh/health                                  |
| MCP health             | https://agents.uploads.sh/health                               |

## What we deliberately do not publish

There is **no** public OAuth/OIDC authorization server for uploads.sh today.
`/.well-known/openid-configuration` and `/.well-known/oauth-authorization-server`
are intentionally absent — agents authenticate with invitation-issued bearer
tokens as above. Do not invent OAuth client registration against this origin.

## Operator note

`ADMIN_TOKEN` is for workspace and invitation administration only. Never place it
in agent configs, prompts, or shared issue comments.
