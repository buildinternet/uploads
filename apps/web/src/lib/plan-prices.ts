/**
 * Live Pro price for the workspace billing tab's plan-comparison cards
 * (issue: billing tab plan comparison). Pure fetch + formatting logic, kept
 * separate from billing.astro's DOM glue the same way billing-cta.ts is.
 *
 * Contract: GET `{authOrigin}/billing/prices` → exactly
 * `{ "prices": { "pro": { "unitAmount": number, "currency": string, "interval": string } | null } }`,
 * `unitAmount` in minor units (e.g. cents). This endpoint is being added by a
 * concurrent lane and may 404 until that lands — treated identically to a
 * `null` price so the page never blocks on it or shows a lie ("$NaN").
 */

export interface PlanPrice {
  unitAmount: number;
  currency: string;
  interval: string;
}

interface PricesResponseBody {
  prices?: { pro?: unknown };
}

function isPlanPrice(value: unknown): value is PlanPrice {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.unitAmount === "number" &&
    Number.isFinite(v.unitAmount) &&
    typeof v.currency === "string" &&
    v.currency.length > 0 &&
    typeof v.interval === "string" &&
    v.interval.length > 0
  );
}

/**
 * GET `{authOrigin}/billing/prices`. Returns `null` for a 404 (endpoint not
 * deployed yet), any other non-2xx, a malformed body, an explicit `null`
 * price, or a thrown fetch (network error, CSP block) — every failure mode
 * collapses to the same "unknown price" state so callers never have to
 * special-case them.
 *
 * Deliberately *not* `credentials: "include"` — this endpoint's CORS
 * (apps/auth/src/index.ts's `billingPricesCors`) is intentionally
 * non-credentialed (public price info, no cookies involved). Sending
 * credentials on a non-credentialed CORS response makes the browser reject
 * it outright, which silently produced this exact "Pro card never shows a
 * price" bug.
 */
export async function fetchProPrice(authOrigin: string): Promise<PlanPrice | null> {
  try {
    const res = await fetch(`${authOrigin.replace(/\/$/, "")}/billing/prices`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as PricesResponseBody | null;
    const pro = body?.prices?.pro;
    return isPlanPrice(pro) ? pro : null;
  } catch {
    return null;
  }
}

/**
 * Formats a price as e.g. "$10.00 per month". Returns `null` when the price
 * is unknown (caller should drop the amount from the card's copy entirely —
 * never render "$NaN" or a placeholder). Falls back to a manual `$` format
 * if `Intl.NumberFormat` rejects the currency code.
 */
export function formatPrice(price: PlanPrice | null): string | null {
  if (!price) return null;
  const amount = price.unitAmount / 100;
  try {
    const formatted = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: price.currency.toUpperCase(),
      minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount);
    return `${formatted} per ${price.interval}`;
  } catch {
    return `$${amount.toFixed(2)} per ${price.interval}`;
  }
}
