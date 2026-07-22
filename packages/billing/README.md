# @uploads/billing

Plan catalog, limit-resolution, and the billing-provider seam for workspace
subscription plans. Every workspace is on the `free` plan today; `pro` is
defined but unavailable (`available: false`) — no Stripe SDK, checkout, or
subscription persistence yet. See
`docs/superpowers/specs/2026-07-22-billing-infrastructure-design.md`.

Private workspace package — not published, excluded from Changesets like
`@uploads/api` / `@uploads/storage` / `@uploads/web` / `@uploads/auth`.
