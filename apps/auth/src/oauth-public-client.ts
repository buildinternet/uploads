/**
 * Adds `official` to the plugin's `/oauth2/public-client` (and
 * `-prelogin`) responses so the consent page can mark operator-verified
 * clients. Self-registered DCR / CIMD clients pick their own name, logo,
 * and homepage, so the only trustworthy identity signal is the operator's
 * `metadata.official` flag (set from /admin/oauth; stripped from
 * registration bodies by oauth-dcr.ts).
 */
import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import { isOfficial } from "./oauth-client-serialize";
import * as schema from "./schema";

export const PUBLIC_CLIENT_PATHS: ReadonlySet<string> = new Set([
  "/oauth2/public-client",
  "/oauth2/public-client-prelogin",
]);

/**
 * Mutates a successful public-client result in place, setting
 * `official: boolean`. Leaves errors and non-objects alone. Fails closed: a
 * lookup error leaves `official: false`.
 */
export async function annotatePublicClientOfficial(
  db: ReturnType<typeof drizzle<typeof schema>>,
  returned: unknown,
): Promise<void> {
  if (returned == null || typeof returned !== "object") return;
  if (returned instanceof Error || returned instanceof Response) return;
  const record = returned as Record<string, unknown>;
  const clientId = record.client_id;
  if (typeof clientId !== "string" || clientId.length === 0) return;
  record.official = false;
  try {
    const [row] = await db
      .select()
      .from(schema.oauthClient)
      .where(eq(schema.oauthClient.clientId, clientId))
      .limit(1);
    record.official = row ? isOfficial(row) : false;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({ message: "public-client official lookup failed", error: message }),
    );
  }
}
