/**
 * The wire shape of an OAuth client registration, shared by every
 * `/internal/oauth-clients*` route in internal-routes.ts.
 *
 * Split out of that router so apps/web's operator pages can `import type` the
 * serialized shape they actually receive (through apps/api's 1:1
 * `/admin-ui/oauth-clients*` proxy) instead of re-declaring it. Keep this
 * module free of worker bindings — the ambient `Env` of whichever app imports
 * it wins, so anything touching `Env` would not typecheck from apps/web.
 */
import * as schema from "./schema";

export type OauthClientRow = typeof schema.oauthClient.$inferSelect;

/** Reads the `official` flag out of the client's metadata JSON blob. */
export function isOfficial(row: OauthClientRow): boolean {
  const metadata = row.metadata as Record<string, unknown> | null;
  return Boolean(metadata && metadata.official === true);
}

export function toEpochMs(value: Date | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.getTime() : value;
}

export type OauthClientStats = {
  consentCount: number;
  activeTokenCount: number;
  lastConsentAt: number | null;
};

export function serializeClient(row: OauthClientRow, stats: OauthClientStats) {
  return {
    clientId: row.clientId,
    name: row.name ?? row.clientId,
    type: row.type,
    public: Boolean(row.public),
    disabled: Boolean(row.disabled),
    official: isOfficial(row),
    redirectUris: row.redirectUris ?? [],
    scopes: row.scopes ?? [],
    uri: row.uri,
    icon: row.icon,
    userId: row.userId,
    skipConsent: Boolean(row.skipConsent),
    createdAt: toEpochMs(row.createdAt),
    updatedAt: toEpochMs(row.updatedAt),
    ...stats,
  };
}

export type SerializedOauthClient = ReturnType<typeof serializeClient>;
