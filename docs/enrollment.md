# Signing in with `uploads login`

`uploads login` is how people and agents get workspace credentials. Run with
no flags it opens a browser for a device sign-in (GitHub or a magic link); on
approval the CLI mints a scoped, expiring workspace token and saves it
locally. Nobody needs the API's `ADMIN_TOKEN` to sign in.

## Everyday login (device flow)

Install once for repeated use:

```bash
npm install --global @buildinternet/uploads
uploads login
uploads doctor
```

Or run it once without a global install:

```bash
npx @buildinternet/uploads login
```

With no code, `uploads login` prints a URL and a short code, opens the URL in
a browser automatically (unless `--no-open`), and waits while you approve the
sign-in there. Once approved, the CLI mints a token and saves it.

Pass `--workspace <name>` if your account can access more than one workspace:

```bash
uploads login --workspace acme
```

On success, the CLI saves `UPLOADS_API_URL`, `UPLOADS_WORKSPACE`, and
`UPLOADS_TOKEN` in the shared buildinternet config and runs `doctor`. It never
prints the raw workspace token. Use `--force` only when intentionally
replacing an existing configured token. See `uploads login --help` for the
full flag list (`--label`, `--scopes`, `--auth-url`, `--no-open`,
`--non-interactive`, and more).

## How you get access to a workspace

There are three ways to get workspace access: **create your own** (self-serve,
no admin needed), an **organization invitation** from someone who already
admins a workspace, or an **enrollment code** shared out-of-band.

### Self-serve: create your own workspace

Any signed-in user with a **GitHub-linked account** can create a workspace
without an invitation or `ADMIN_TOKEN` — `/account/workspaces` has a "Create a
workspace" form, and `uploads login` offers the same prompt when your account
has no workspaces yet. Scripted or agent logins can skip the prompt with
`uploads login --workspace <name> --create`, which provisions the workspace
during login when the account doesn't already have it (browser device
approval is still required once). You become the owner of a new organization and a
`<name>/` prefix on the shared bucket, capped at 3 self-serve workspaces per
user and with tighter default limits than an operator-provisioned workspace.
See [workspaces.md#self-serve-workspaces](workspaces.md#self-serve-workspaces)
for the limits, name rules, and error codes.

Magic-link-only accounts get a `github_required` prompt to connect GitHub
first, in both the web UI and `uploads login`.

### Organization invitation

Workspace access also comes from an **organization invitation**, not a code
you redeem. Someone who already **admins that workspace** (org role
admin/owner) invites your email:

- **Account UI** — `/account/workspaces` → “Invite a teammate”
- **CLI** — `uploads invite create --email you@example.com --workspace <name>`
  (device login as the inviter; no `ADMIN_TOKEN`)
- **Site operators** can also invite from `/admin` (global admin session)

You get an accept link (email when Email Sending is configured; otherwise the
inviter shares the link from the UI/CLI). After accepting (GitHub or magic-link
sign-in), run `uploads login`. See [ops.md#invitations](ops.md#invitations) for
operator-only enrollment codes and self-hosted email notes.

## Alternative: enrollment codes / invite links (`--code`)

Administrators can also mint single-use **enrollment codes** (`upe_…`) via
`ADMIN_TOKEN`-authenticated `POST /admin/enrollments`, and `uploads login
--code` exchanges one for a token directly, with no organization membership
involved. This is a secondary path, useful when you want to share a
code or link without knowing the recipient's email address in advance
(e.g. a link posted to a channel, or handed off out-of-band). Org
invitations above remain the primary, recommended way to onboard someone
whose email you know.

```bash
uploads login --code upe_…
# or, to avoid the code in shell history:
UPLOADS_ENROLLMENT_CODE=upe_<workspace>_… uploads login --code-stdin
```

Interactive `--code` prompts without echoing the code. For automation, use an
ephemeral environment value rather than putting the code in shell history or
the process list.

## Token policy

Login-issued tokens default to:

- 90-day lifetime;
- `files:read` for list and metadata operations;
- `files:write` for uploads;
- no `files:delete` unless explicitly authorized.

The API stores token hashes, scopes, labels, creation time, and expiry — not
raw tokens. Revocation uses the admin token-list and revoke endpoints (see
[admin-tokens](admin-tokens.md)). Existing tokens without scopes or expiry
remain valid with their legacy access until deliberately rotated or revoked.

## D1 state and deployment

D1 stores every scoped/expiring token and, for the legacy enrollment path,
enrollment requests with atomic single-use redemption. `REGISTRY` KV retains
workspace storage configuration and legacy tokens. Create and migrate the
database before deploying auth-aware API code:

```bash
cd apps/api
pnpm exec wrangler d1 create uploads-production
pnpm exec wrangler d1 migrations apply DB --local
pnpm exec wrangler d1 migrations apply DB --remote
# or: pnpm --filter @uploads/api run migrate:d1
```

Bind the database as `DB` in `apps/api/wrangler.jsonc`. Commit migrations under
`apps/api/migrations/`; remote apply runs via `deploy:api`, the **D1 Migrations**
GitHub Action on merge to main, or `migrate:d1` manually. See [deploy](deploy.md).

The dedicated `apps/auth` worker and its own `uploads-auth` D1 database carry
Better Auth's session/organization/device-code tables that back
`uploads login` and the `/admin` UI — see `apps/auth/README.md`.

## Migration notes

`uploads login`'s device flow (Better Auth's device-authorization grant) is
the default onboarding path today. Direct token minting (`/admin/tokens`) is
reserved for CI and break-glass administration. Rotate legacy routine-agent
tokens to login-issued tokens gradually, then revoke the old hashes.
