#!/usr/bin/env node
/**
 * Doctor-style check that Stripe (live) agrees with the plan catalog
 * (packages/billing/src/plans.ts): the configured price exists, is active,
 * is a monthly recurring price, and its product's name matches PLANS.pro.name.
 * Copy in plans.ts is the source of truth for what we tell customers — this
 * catches Stripe dashboard drift (price archived, interval changed, product
 * renamed) before it becomes a support ticket.
 *
 * Talks to the *live* Stripe API directly via fetch (no SDK dependency
 * needed for a one-shot script). Reads two env vars that are NOT in this
 * repo's committed files — both live in the main (non-worktree) checkout's
 * .env:
 *
 *   STRIPE_LIVE_OPERATOR_KEY  restricted/secret live Stripe API key
 *   STRIPE_PRO_PRICE_ID       the live `price_...` id sold as PLANS.pro
 *
 * This script only reads process.env — it never reads or edits .env files
 * itself. Run it with those two vars exported into the shell, e.g.:
 *
 *   STRIPE_LIVE_OPERATOR_KEY=rk_live_... STRIPE_PRO_PRICE_ID=price_... \
 *     node scripts/stripe/reconcile-plans.mjs
 *
 * Exits non-zero on any FAIL row so it can be wired into a doctor/CI check.
 */
import { PLANS } from "../../packages/billing/src/plans.ts";

const STRIPE_API = "https://api.stripe.com/v1";

const apiKey = process.env.STRIPE_LIVE_OPERATOR_KEY;
const priceId = process.env.STRIPE_PRO_PRICE_ID;

if (process.argv.includes("--help")) {
  process.stdout
    .write(`Reconcile the live Stripe pro price/product against packages/billing/src/plans.ts.

Usage:
  STRIPE_LIVE_OPERATOR_KEY=... STRIPE_PRO_PRICE_ID=... node scripts/stripe/reconcile-plans.mjs

Environment (read from the main checkout's .env, not this repo's):
  STRIPE_LIVE_OPERATOR_KEY  restricted/secret live Stripe API key
  STRIPE_PRO_PRICE_ID       the live price id sold as PLANS.pro

Exits non-zero if the price is missing/inactive/non-monthly, or if the
product name doesn't match PLANS.pro.name.
`);
  process.exit(0);
}

const rows = [];
function check(name, pass, detail) {
  rows.push({ name, pass, detail });
}

async function stripeGet(path) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe ${path} → ${res.status}: ${body?.error?.message ?? "unknown error"}`);
  }
  return body;
}

async function main() {
  if (!apiKey) {
    check("STRIPE_LIVE_OPERATOR_KEY is set", false, "missing from environment");
  }
  if (!priceId) {
    check("STRIPE_PRO_PRICE_ID is set", false, "missing from environment");
  }
  if (!apiKey || !priceId) {
    printReport();
    process.exit(1);
  }

  let price;
  try {
    price = await stripeGet(`/prices/${encodeURIComponent(priceId)}?expand[]=product`);
    check("price exists", true, price.id);
  } catch (err) {
    check("price exists", false, err instanceof Error ? err.message : String(err));
    printReport();
    process.exit(1);
  }

  check("price is active", price.active === true, `active=${price.active}`);
  check(
    "price is recurring",
    price.type === "recurring" && !!price.recurring,
    `type=${price.type}`,
  );
  check(
    "price interval is month",
    price.recurring?.interval === "month",
    `interval=${price.recurring?.interval ?? "n/a"}`,
  );

  const product = price.product;
  const productName = typeof product === "object" && product !== null ? product.name : undefined;
  // Stripe's product name is invoice-facing, so a branded "Uploads <name>"
  // form of the in-app catalog name is conforming, not drift.
  check(
    "product name matches PLANS.pro.name",
    productName === PLANS.pro.name || productName === `Uploads ${PLANS.pro.name}`,
    `stripe="${productName}" catalog="${PLANS.pro.name}"`,
  );

  printReport();
  process.exit(rows.some((r) => !r.pass) ? 1 : 0);
}

function printReport() {
  const width = Math.max(...rows.map((r) => r.name.length), 10);
  console.log("Stripe plan reconciliation");
  console.log("--------------------------");
  for (const row of rows) {
    const status = row.pass ? "PASS" : "FAIL";
    console.log(`[${status}] ${row.name.padEnd(width)}  ${row.detail}`);
  }
  const failed = rows.filter((r) => !r.pass).length;
  console.log("--------------------------");
  console.log(failed === 0 ? `All ${rows.length} checks passed.` : `${failed} check(s) FAILED.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
