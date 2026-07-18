# auth.md

Agent authentication for **uploads.sh** — device sign-in and workspace bearer
tokens.

## Audience

Coding agents, CLI automation, and the hosted MCP server. Humans use the same
flow via `uploads login`. Routine agents never receive `ADMIN_TOKEN`.

## How agents get credentials

1. Someone with workspace access (see "Getting workspace access" below) runs:

```bash
npm install --global @buildinternet/uploads
uploads login
```

2. `uploads login` opens a browser device-authorization flow (GitHub or
   magic-link sign-in) and prints the URL/code too, for headless machines
   where the auto-opened browser isn't the one you'll approve in. Approve the
   sign-in, and the CLI mints and saves a workspace token.
3. If the account can access more than one workspace, pass
   `--workspace <name>`.

```bash
uploads login --workspace acme
```

On success the CLI writes `UPLOADS_API_URL`, `UPLOADS_WORKSPACE`, and
`UPLOADS_TOKEN` to the shared buildinternet config and runs `uploads doctor`.
The raw token is not printed.

Details: [enrollment docs](https://github.com/buildinternet/uploads/blob/main/docs/enrollment.md).

## Getting workspace access

An uploads.sh administrator invites your email address to the workspace's
organization from the session-authenticated `/admin` UI. Accept the
invitation (GitHub or magic-link sign-in), then run `uploads login` as above.
There is no self-serve signup.

## Using the credential

Send the workspace token on every protected request:

```http
Authorization: Bearer up_<workspace>_…
```

| Scope          | Default on login | Use                               |
| -------------- | ---------------- | --------------------------------- |
| `files:read`   | yes              | list, metadata, usage             |
| `files:write`  | yes              | upload, reconcile                 |
| `files:delete` | no               | delete / purge (admin must grant) |

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

## OAuth for the hosted MCP

`https://agents.uploads.sh/mcp` also accepts OAuth 2.1 bearer tokens issued by
our authorization server at `https://auth.uploads.sh` (issuer
`https://auth.uploads.sh/api/auth`). It supports PKCE and dynamic client
registration (RFC 7591) — an MCP client can register itself, no manual setup.
Discovery:

```bash
curl -s https://auth.uploads.sh/.well-known/oauth-authorization-server
curl -s https://auth.uploads.sh/.well-known/openid-configuration
```

Scopes are the same three as the workspace-token table above: `files:read`,
`files:write`, `files:delete`. A human authorizing a client signs in and
grants scopes at `https://uploads.sh/oauth/consent`. This is the auth surface
for third-party OAuth clients against the hosted MCP; `uploads login`'s device
flow (above) is unrelated and still the way to mint a long-lived
`up_<workspace>_…` workspace token for CLI/agent use.

`api.uploads.sh` does not accept OAuth tokens in v1 — only the hosted MCP
does.

## Operator note

`ADMIN_TOKEN` is a break-glass ops/CI credential, not the routine way to
invite people or mint tokens — see [admin-tokens](https://github.com/buildinternet/uploads/blob/main/docs/admin-tokens.md).
Never place it in agent configs, prompts, or shared issue comments.
