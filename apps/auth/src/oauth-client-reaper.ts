/**
 * Nightly stale OAuth-client reaper (issue #224, Lane A DCR follow-up).
 *
 * Dynamic client registration lets anyone self-register at the public
 * `/api/auth/oauth2/register` endpoint (see src/auth.ts's
 * `allowUnauthenticatedClientRegistration`), so abandoned registrations
 * (a probe, MCP Inspector, or an agent that registered but never completed
 * auth) accumulate as `oauth_client` rows. This sweep purges them.
 *
 * A client is REAPABLE only when ALL hold:
 *   - older than the retention window (default 30d,
 *     `OAUTH_CLIENT_REAPER_RETENTION_DAYS`),
 *   - anonymous (`user_id` null) — this repo has no admin-provisioned
 *     `oauth2/create-client` path yet, but the guard is cheap insurance if
 *     one is added later,
 *   - NOT trusted (`skip_consent` ≠ true) — a future first-party
 *     skip-consent client should never be swept,
 *   - zero `oauth_consent` rows AND zero token rows — no user ever
 *     authorized it.
 *
 * Gated by `OAUTH_CLIENT_REAPER_ENABLED` (default **off** = OBSERVE-ONLY):
 * candidates are computed and logged; nothing is deleted until the env var
 * is set to `"true"`. Prior art: `~/Code/sunny/apps/auth/src/oauth-client-reaper.ts`
 * (this repo has no Flagship binding, so the gate is a plain env var).
 *
 * Called from the existing `15 6 * * *` cron alongside the retention sweep
 * (see src/index.ts's `scheduled` handler).
 */
import { and, eq, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { AuthEnv } from "./auth";
import * as schema from "./schema";

export const DEFAULT_RETENTION_DAYS = 30;
/** Cap the client_id sample logged per run so the audit line stays lean. */
const CLIENT_ID_LOG_SAMPLE = 50;

export type OauthClientReaperEnv = AuthEnv & {
  OAUTH_CLIENT_REAPER_ENABLED?: string;
  OAUTH_CLIENT_REAPER_RETENTION_DAYS?: string;
  /** TEST-ONLY: pin wall-clock so retention cutoffs don't rot as real time advances. */
  _now?: Date;
  /** TEST-ONLY: inject a store so unit tests need no real D1. */
  _store?: OauthClientReaperStore;
};

export type OauthClientCandidate = { id: string; clientId: string };

/** Storage seam — production uses Drizzle/D1; tests run the real store over fake D1. */
export interface OauthClientReaperStore {
  /** Age/anonymous/untrusted candidates, before the never-used check (observability). */
  listCandidates(cutoff: Date): Promise<OauthClientCandidate[]>;
  /** Candidates that additionally have no consent/token rows (observe mode). */
  listReapable(cutoff: Date): Promise<OauthClientCandidate[]>;
  /** Delete reapable clients, re-checking EVERY predicate at statement time. */
  deleteReapable(cutoff: Date): Promise<OauthClientCandidate[]>;
}

export function parseRetentionDays(raw: string | undefined): number {
  const n = Number(raw ?? DEFAULT_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_RETENTION_DAYS;
}

export function drizzleOauthClientReaperStore(db: D1Database): OauthClientReaperStore {
  const d = drizzle(db, { schema });
  // Anonymous DCR only (user_id null) + not trusted (skip_consent) + stale.
  const candidateWhere = (cutoff: Date) =>
    and(
      lt(schema.oauthClient.createdAt, cutoff),
      isNull(schema.oauthClient.userId),
      or(isNull(schema.oauthClient.skipConsent), eq(schema.oauthClient.skipConsent, false)),
    );
  // Never used: correlated NOT EXISTS per usage table, evaluated inside the
  // SAME statement as the read/delete it guards — a consent or token created
  // between a separate "collect ids" read and the delete could otherwise be
  // orphaned (or trip the token tables' FKs). Also keeps usage checks in SQL
  // instead of loading every historical consent/token client_id into memory.
  const neverUsed = () =>
    and(
      ...([schema.oauthConsent, schema.oauthAccessToken, schema.oauthRefreshToken] as const).map(
        (table) =>
          notExists(
            d
              .select({ one: sql`1` })
              .from(table)
              .where(eq(table.clientId, schema.oauthClient.clientId)),
          ),
      ),
    );
  const projection = { id: schema.oauthClient.id, clientId: schema.oauthClient.clientId };
  return {
    async listCandidates(cutoff) {
      return d.select(projection).from(schema.oauthClient).where(candidateWhere(cutoff));
    },
    async listReapable(cutoff) {
      return d
        .select(projection)
        .from(schema.oauthClient)
        .where(and(candidateWhere(cutoff), neverUsed()));
    },
    async deleteReapable(cutoff) {
      return d
        .delete(schema.oauthClient)
        .where(and(candidateWhere(cutoff), neverUsed()))
        .returning(projection);
    },
  };
}

export type SweepOauthClientsResult = {
  mode: "observe" | "delete";
  retentionDays: number;
  candidates: number;
  reapable: number;
  deleted: number;
  clientIds: string[];
  notes: string;
};

/**
 * Run one reaper pass. Never throws for business logic; DB failures propagate
 * so the Workers scheduled handler can surface them.
 */
export async function sweepOauthClients(
  env: OauthClientReaperEnv,
): Promise<SweepOauthClientsResult> {
  const now = env._now ?? new Date();
  const retentionDays = parseRetentionDays(env.OAUTH_CLIENT_REAPER_RETENTION_DAYS);
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const deleteEnabled = env.OAUTH_CLIENT_REAPER_ENABLED === "true";

  const store = env._store ?? drizzleOauthClientReaperStore(env.DB);
  const candidates = await store.listCandidates(cutoff);
  // Delete mode never trusts a prior read: deleteReapable re-evaluates every
  // predicate (incl. never-used) in the delete statement itself.
  const reapable = deleteEnabled
    ? await store.deleteReapable(cutoff)
    : await store.listReapable(cutoff);
  const deleted = deleteEnabled ? reapable.length : 0;

  const mode = deleteEnabled ? "delete" : "observe";
  const clientIds = reapable.slice(0, CLIENT_ID_LOG_SAMPLE).map((c) => c.clientId);
  const notes = `mode=${mode} candidates=${candidates.length} reapable=${reapable.length} deleted=${deleted} (anonymous, no consent/tokens, older than ${retentionDays}d)`;

  console.log(
    JSON.stringify({
      message: "oauth_client_reaper",
      mode,
      retentionDays,
      candidates: candidates.length,
      reapable: reapable.length,
      deleted,
      clientIds,
    }),
  );

  return {
    mode,
    retentionDays,
    candidates: candidates.length,
    reapable: reapable.length,
    deleted,
    clientIds,
    notes,
  };
}
