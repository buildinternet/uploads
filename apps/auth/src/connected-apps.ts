/**
 * Issue #890: a signed-in "Connected apps" page (apps/web's
 * /account/connected-apps) needs to list a user's OAuth grants and revoke
 * one on demand.
 *
 * `@better-auth/oauth-provider` already exposes `GET /oauth2/get-consents`
 * (raw `oauth_consent` rows, no client join) and `POST /oauth2/delete-
 * consent` ({id}, ownership-checked) — but delete-consent only removes the
 * consent row and leaves any `oauth_access_token`/`oauth_refresh_token` rows
 * for that grant valid. RFC 7009's `/oauth2/revoke` needs client
 * credentials, so it's unusable from a session. This file adds the two
 * endpoints the page actually needs, mirroring `workspace-choice.ts`'s
 * pattern (createAuthEndpoint + sessionMiddleware + drizzle):
 *
 *  - `GET /oauth2/connected-apps` — the session user's `oauth_consent` rows
 *    joined to `oauth_client` (name/icon/uri), plus an active-token count
 *    per grant (pattern: internal-routes.ts's oauth-clients aggregate).
 *  - `POST /oauth2/connected-apps/revoke` `{id}` — deletes the consent row
 *    AND stamps `revoked` on every access/refresh token row for that
 *    user+client+referenceId, so the grant is actually dead, not just
 *    hidden from future consent screens.
 */
import { createAuthEndpoint, sessionMiddleware, APIError } from "better-auth/api";
import { and, count, eq, isNull, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface ConnectedAppGrant {
  id: string;
  clientId: string;
  clientName: string | null;
  clientIcon: string | null;
  clientUri: string | null;
  scopes: string[];
  referenceId: string | null;
  activeTokenCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/**
 * The session user's grants, newest first. Consent rows without a matching
 * `oauth_client` (deleted/reaped client) are still returned — `clientName`
 * etc. fall back to `null` and the web page falls back to the raw
 * `clientId` — since the tokens they authorized may still be live and
 * revocable.
 */
async function loadConnectedApps(db: Db, userId: string): Promise<ConnectedAppGrant[]> {
  const consents = await db
    .select()
    .from(schema.oauthConsent)
    .where(eq(schema.oauthConsent.userId, userId))
    .orderBy(schema.oauthConsent.createdAt);
  consents.reverse();
  if (consents.length === 0) return [];

  const clientIds = [...new Set(consents.map((c) => c.clientId))];
  const clients = await db.select().from(schema.oauthClient);
  const clientById = new Map(
    clients.filter((c) => clientIds.includes(c.clientId)).map((c) => [c.clientId, c]),
  );

  const now = new Date();
  const grants: ConnectedAppGrant[] = [];
  for (const consent of consents) {
    const client = clientById.get(consent.clientId);
    const [tokenRow] = await db
      .select({ activeTokenCount: count() })
      .from(schema.oauthRefreshToken)
      .where(
        and(
          eq(schema.oauthRefreshToken.userId, userId),
          eq(schema.oauthRefreshToken.clientId, consent.clientId),
          consent.referenceId
            ? eq(schema.oauthRefreshToken.referenceId, consent.referenceId)
            : isNull(schema.oauthRefreshToken.referenceId),
          isNull(schema.oauthRefreshToken.revoked),
          gt(schema.oauthRefreshToken.expiresAt, now),
        ),
      );

    grants.push({
      id: consent.id,
      clientId: consent.clientId,
      clientName: client?.name ?? null,
      clientIcon: client?.icon ?? null,
      clientUri: client?.uri ?? null,
      scopes: consent.scopes ?? [],
      referenceId: consent.referenceId ?? null,
      activeTokenCount: tokenRow?.activeTokenCount ?? 0,
      createdAt: toIso(consent.createdAt),
      updatedAt: toIso(consent.updatedAt),
    });
  }
  return grants;
}

export function connectedAppsPlugin(db: Db) {
  return {
    id: "uploads-oauth-connected-apps",
    endpoints: {
      /** `GET /oauth2/connected-apps` — session-required. `{ grants: ConnectedAppGrant[] }`. */
      oauthConnectedApps: createAuthEndpoint(
        "/oauth2/connected-apps",
        {
          method: "GET",
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const userId = ctx.context.session.user.id;
          return ctx.json({ grants: await loadConnectedApps(db, userId) });
        },
      ),
      /**
       * `POST /oauth2/connected-apps/revoke` — session-required, body
       * `{ id }` (the `oauth_consent` row id). Verifies the consent belongs
       * to the caller, deletes it, and stamps `revoked` on every
       * access/refresh token row matching user+client+referenceId. 404s
       * with `code: "not_found"` for a missing/foreign id rather than
       * leaking whether some other user's consent id exists.
       */
      oauthConnectedAppsRevoke: createAuthEndpoint(
        "/oauth2/connected-apps/revoke",
        {
          method: "POST",
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const userId = ctx.context.session.user.id;
          const rawId = (ctx.body as { id?: unknown } | undefined)?.id;
          if (typeof rawId !== "string" || rawId.length === 0) {
            throw new APIError("BAD_REQUEST", {
              code: "invalid_request",
              message: "`id` must be a non-empty string.",
            });
          }

          const [consent] = await db
            .select()
            .from(schema.oauthConsent)
            .where(eq(schema.oauthConsent.id, rawId))
            .limit(1);
          if (!consent || consent.userId !== userId) {
            throw new APIError("NOT_FOUND", {
              code: "not_found",
              message: "No such connected app.",
            });
          }

          const referenceMatch = consent.referenceId
            ? eq(schema.oauthAccessToken.referenceId, consent.referenceId)
            : isNull(schema.oauthAccessToken.referenceId);
          const refreshReferenceMatch = consent.referenceId
            ? eq(schema.oauthRefreshToken.referenceId, consent.referenceId)
            : isNull(schema.oauthRefreshToken.referenceId);

          const now = new Date();
          await Promise.all([
            db.delete(schema.oauthConsent).where(eq(schema.oauthConsent.id, consent.id)),
            db
              .update(schema.oauthAccessToken)
              .set({ revoked: now })
              .where(
                and(
                  eq(schema.oauthAccessToken.userId, userId),
                  eq(schema.oauthAccessToken.clientId, consent.clientId),
                  referenceMatch,
                ),
              ),
            db
              .update(schema.oauthRefreshToken)
              .set({ revoked: now })
              .where(
                and(
                  eq(schema.oauthRefreshToken.userId, userId),
                  eq(schema.oauthRefreshToken.clientId, consent.clientId),
                  refreshReferenceMatch,
                ),
              ),
          ]);

          return ctx.json({ status: true });
        },
      ),
    },
  };
}
