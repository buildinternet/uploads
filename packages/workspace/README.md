# @uploads/workspace

Workspace identity facts that more than one worker has to agree on — today,
which slug is the communal workspace (`COMMUNAL_WORKSPACE`,
`isCommunalWorkspace`). Enforcement lives with the rules it belongs to
(slug reservation in `apps/api/src/slug-policy.ts`, the member-cap exemption in
`apps/api/src/routes/internal-billing.ts`); this package only says which
workspace they are all talking about.

Clients are told, not left to infer: `/me/workspaces` stamps `communal` on each
membership entry, so `apps/web` reads a flag instead of matching a slug.

Private workspace package — not published, excluded from Changesets like
`@uploads/api` / `@uploads/billing` / `@uploads/web` / `@uploads/auth`.
