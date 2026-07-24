# @uploads/billing

Plan catalog, limit-resolution, and the billing-provider seam for workspace
subscription plans. Both plans are live: `free` is available in perpetuity, and
`pro` is purchasable through Stripe Checkout, mounted by
`apps/auth/src/stripe-plugin.ts`. See
`docs/superpowers/specs/2026-07-22-billing-infrastructure-design.md` for the
original design.

Private workspace package — not published, excluded from Changesets like
`@uploads/api` / `@uploads/storage` / `@uploads/web` / `@uploads/auth`.

## Terms checkbox at checkout

Stripe Checkout already shows the price, the currency, and the billing
interval, and creates the session in subscription mode, so the recurring nature
is visible to the buyer without any work from us. What it does not do by
default is collect agreement to _our_ Terms at the moment of purchase.

`checkoutConsentParams` (`src/stripe-checkout.ts`) turns that on. **Production
has it on** — `apps/auth/wrangler.jsonc` is the source of truth for which
environments do. The code default stays off, so any environment that does not
set the var behaves as it always did.

**The two halves have an order, and reversing it breaks the purchase path.**
Stripe rejects a session requesting `consent_collection` when the account has
no Terms URL, and that rejection surfaces as a dead upgrade button for every
customer. So:

1. In the Stripe Dashboard, set **Settings → Public business information →
   Terms of service** to `https://uploads.sh/terms`. Always first. (Done for
   the live account on 2026-07-24.)
2. Set `STRIPE_CHECKOUT_TOS_CONSENT` to exactly `true` on the `uploads-auth`
   worker.
3. Run a checkout and confirm the checkbox renders.

The same order applies in reverse. If that Dashboard field is ever cleared,
remove the var in the same change — leaving the var set against an account with
no Terms URL is the broken state. To disable deliberately, drop the var; any
value other than `true` leaves Checkout as it was.
