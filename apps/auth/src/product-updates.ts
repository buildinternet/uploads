/**
 * Sign-up opt-out for product update emails. The sign-in pages set this
 * short-lived cookie when the person unticks "Email me product updates"
 * (apps/web/src/components/ProductUpdatesConsent.astro). Auth is served
 * same-origin through web's `/api/auth` proxy, so the cookie rides along on
 * the magic-link click and the GitHub callback, and the session hook in
 * auth.ts turns the preference off.
 *
 * Only ever turns the preference off: a ticked box leaves an earlier
 * opt-out alone.
 */

export const PRODUCT_UPDATES_OPT_OUT_COOKIE = "uploads_product_updates";
export const PRODUCT_UPDATES_OPT_OUT_VALUE = "off";

/** True when the request carries the sign-up opt-out cookie. */
export function hasProductUpdatesOptOut(headers: Headers | undefined | null): boolean {
  const cookie = headers?.get("cookie");
  if (!cookie) return false;
  return cookie
    .split(";")
    .some(
      (part) =>
        part.trim() === `${PRODUCT_UPDATES_OPT_OUT_COOKIE}=${PRODUCT_UPDATES_OPT_OUT_VALUE}`,
    );
}
