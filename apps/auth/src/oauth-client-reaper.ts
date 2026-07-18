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
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { AuthEnv } from "./auth";
import * as schema from "./schema";

export const DEFAULT_RETENTION_DAYS = 30;
/** Cap the client_id sample logged per run so the audit line stays lean. */
const CLIENT_ID_LOG_SAMPLE = 50;
/** D1 allows ≤100 bound params per statement; chunk id-lists well under that. */
const DELETE_CHUNK = 90;

export type OauthClientReaperEnv = AuthEnv & {
  OAUTH_CLIENT_REAPER_ENABLED?: string;
  OAUTH_CLIENT_REAPER_RETENTION_DAYS?: string;
  /** TEST-ONLY: pin wall-clock so retention cutoffs don't rot as real time advances. */
  _now?: Date;
  /** TEST-ONLY: inject a store so unit tests need no real D1. */
  _store?: OauthClientReaperStore;
};

export type OauthClientCandidate = { id: string; clientId: string };

/** Storage seam — production uses Drizzle/D1; tests inject an in-memory fake. */
export interface OauthClientReaperStore {
  listCandidates(cutoff: Date): Promise<OauthClientCandidate[]>;
  collectInUseClientIds(): Promise<Set<string>>;
  deleteByIds(ids: string[]): Promise<number>;
}

export function parseRetentionDays(raw: string | undefined): number {
  const n = Number(raw ?? DEFAULT_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_RETENTION_DAYS;
}

/** Pure filter: candidates that have never been used. */
export function filterReapable(
  candidates: OauthClientCandidate[],
  inUse: ReadonlySet<string>,
): OauthClientCandidate[] {
  return candidates.filter((c) => !inUse.has(c.clientId));
}

export function drizzleOauthClientReaperStore(db: D1Database): OauthClientReaperStore {
  const d = drizzle(db, { schema });
  return {
    async listCandidates(cutoff) {
      // Anonymous DCR only (user_id null) + not trusted (skip_consent).
      return d
        .select({ id: schema.oauthClient.id, clientId: schema.oauthClient.clientId })
        .from(schema.oauthClient)
        .where(
          and(
            lt(schema.oauthClient.createdAt, cutoff),
            isNull(schema.oauthClient.userId),
            or(isNull(schema.oauthClient.skipConsent), eq(schema.oauthClient.skipConsent, false)),
          ),
        );
    },
    async collectInUseClientIds() {
      const inUse = new Set<string>();
      for (const table of [
        schema.oauthConsent,
        schema.oauthAccessToken,
        schema.oauthRefreshToken,
      ] as const) {
        // Sequential: three small distinct lookups; NOT IN (subquery) is
        // messier with SQLite nulls and harder to test.
        // oxlint-disable-next-line no-await-in-loop -- intentional sequential reads
        const rows = await d.select({ clientId: table.clientId }).from(table);
        for (const r of rows) inUse.add(r.clientId);
      }
      return inUse;
    },
    async deleteByIds(ids) {
      if (ids.length === 0) return 0;
      let deleted = 0;
      for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
        const chunk = ids.slice(i, i + DELETE_CHUNK);
        // oxlint-disable-next-line no-await-in-loop -- chunked under D1 bind cap
        const res = await d
          .delete(schema.oauthClient)
          .where(inArray(schema.oauthClient.id, chunk))
          .returning({ id: schema.oauthClient.id });
        deleted += res.length;
      }
      return deleted;
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
  const inUse = await store.collectInUseClientIds();
  const reapable = filterReapable(candidates, inUse);

  let deleted = 0;
  if (deleteEnabled && reapable.length > 0) {
    deleted = await store.deleteByIds(reapable.map((c) => c.id));
  }

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
