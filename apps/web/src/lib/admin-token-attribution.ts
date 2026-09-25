import type { AdminTokenRow } from "./admin-api";

/**
 * Who an admin token row is attributed to, or null when it carries no user id
 * (legacy KV tokens, pre-tracking rows). A service token (`owner:
 * "workspace"`) names the admin who created it; a personal token names its
 * minting member. Ids resolve through `emailByUserId`; an id with no match
 * (a former member) shows raw.
 */
export function tokenAttribution(
  token: Pick<AdminTokenRow, "owner" | "mintingUserId" | "createdByUserId">,
  emailByUserId: ReadonlyMap<string, string>,
): string | null {
  const id = token.owner === "workspace" ? token.createdByUserId : token.mintingUserId;
  if (!id) return null;
  const who = emailByUserId.get(id) ?? id;
  return token.owner === "workspace" ? `created by ${who}` : `minted by ${who}`;
}
