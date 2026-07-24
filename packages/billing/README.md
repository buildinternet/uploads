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

`checkoutConsentParams` (`src/stripe-checkout.ts`) turns that on, and it is off
until an operator asks for it. Enabling it out of order breaks the purchase
path: Stripe rejects a session that requests `consent_collection` when the
account has no Terms URL, so the upgrade button would fail for everyone.

Enable in this order:

1. In the Stripe Dashboard, set **Settings → Public business information →
   Terms of service** to `https://uploads.sh/terms`. Do this first.
2. Set `STRIPE_CHECKOUT_TOS_CONSENT` to exactly `true` on the `uploads-auth`
   worker.
3. Run a test-mode checkout and confirm the checkbox renders before you rely
   on it.

To turn it back off, unset the variable — any value other than `true` leaves
Checkout as it is today.
