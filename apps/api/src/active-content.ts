/**
 * Gate for SVG/XML "active content" uploads (issue #929, design doc
 * "Decision: one mechanism, per lane" / "Gate"). `image/svg+xml`,
 * `application/xml`, and `text/xml` are declared-only types
 * (`apps/api/src/guards.ts`) accepted on a lane only while that lane's
 * public host is verified to serve them behind a sandboxing CSP — this is
 * the single choke point every caller (`putObject`, presign, ingest, the
 * MCP ceiling) asks.
 *
 * Modeled directly on `posterGenerationAllowed` (`./poster.ts`): cheapest
 * checks first, Flagship fails closed (a missing binding, a disabled flag,
 * and a thrown evaluation are all indistinguishable from "off"), and a
 * workspace-level opt-out short-circuits everything else. What's different
 * from the poster gate is the lane split — a shared-bucket workspace
 * inherits the *host's* daily-probed verdict from KV (every workspace on
 * that host shares one Transform Rule), while a BYO workspace carries its
 * own stamp because only its owner controls that host's headers.
 *
 * A shared-lane workspace's object is actually reachable through *two*
 * hosts — the stable `ws.publicBaseUrl` host and, when it's one of the
 * default embeddable hosts, the `embed.uploads.sh` twin `objectPublicUrls`
 * (`./storage.ts`) also hands out for it (`resolveEmbedBaseUrl`, same
 * `@uploads/storage` helper). Gating on the stable host's record alone would
 * let SVG/XML through on a URL an unverified host still serves un-sandboxed,
 * so the shared-lane branch below requires a fresh `ok` record for *every*
 * host that can serve the object.
 */
import { hostOf, resolveEmbedBaseUrl } from "@uploads/storage";
import { isSharedLane } from "./storage";
import { readHostActiveContent } from "./active-content-hosts";
import type { WorkspaceRecord } from "./workspace";

/** Flagship kill switch, fail-closed like `POSTER_FLAG`. */
export const ACTIVE_CONTENT_FLAG = "active-content-uploads";

/**
 * How long a hosted host's daily-probed KV record stays trusted. Comfortably
 * wider than the daily cron interval so one missed/slow run doesn't flip
 * every workspace on that host off; a genuinely broken Transform Rule still
 * closes the gate within two days.
 */
export const HOST_RECORD_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * How long a BYO lane's own `storageActiveContentVerifiedAt` stamp stays
 * trusted — far wider than the hosted host window because nothing re-probes
 * a BYO lane on a schedule (only save-time verify, "Check now", and the
 * lane-verify route touch it). A month is long enough that an abandoned
 * lane's SVG/XML acceptance quietly expires rather than staying trusted
 * forever.
 */
export const LANE_STAMP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * True when `iso` parses and is within `maxAgeMs` of `now`. Absent or
 * unparseable is never fresh. Exported so the settings projection
 * (`routes/workspace-settings.ts`) judges a lane stamp by exactly the rule
 * the gate below judges it by, instead of reimplementing the arithmetic.
 */
export function fresh(iso: string | undefined, maxAgeMs: number, now: Date): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t <= maxAgeMs;
}

/** Why the gate is closed, when it is. Absent on an allowed status. */
export type ActiveContentReason =
  | "opted_out"
  | "flag_off"
  | "unhealthy"
  | "host_stale"
  | "host_missing"
  | "lane_stale"
  | "lane_missing";

/**
 * The gate's verdict plus what a display needs to explain it: the timestamp
 * it actually trusted (a hosted host's KV record, or a BYO lane's own stamp)
 * and, when the gate is closed, which check closed it.
 */
export interface ActiveContentStatus {
  allowed: boolean;
  /** Only ever set when the lane check passed — a fresh, passing stamp. */
  verifiedAt?: string;
  reason?: ActiveContentReason;
}

/** One hosted host's KV record as a status: fresh and `ok` allows; anything else says why not. */
async function hostStatus(env: Env, host: string, now: Date): Promise<ActiveContentStatus> {
  const record = await readHostActiveContent(env, host);
  if (!record?.ok) return { allowed: false, reason: "host_missing" };
  if (!fresh(record.verifiedAt, HOST_RECORD_MAX_AGE_MS, now)) {
    return { allowed: false, reason: "host_stale" };
  }
  return { allowed: true, verifiedAt: record.verifiedAt };
}

/**
 * Every gate, cheapest first: workspace opt-out, missing/disabled/thrown
 * Flagship flag, a lane currently flagged unhealthy (issue #826 — a
 * struggling BYO lane never gets active-content treated as a new problem to
 * diagnose), then the lane-specific freshness check.
 *
 * Shared lane: reads `REGISTRY`'s `host-active-content:<host>` record (see
 * `./active-content-hosts.ts`, written by the daily cron/admin probe) for
 * the hostname of `ws.publicBaseUrl` — allowed only when that record exists,
 * passed, and is within `HOST_RECORD_MAX_AGE_MS` *and* the same is true of
 * the embed twin's host when `resolveEmbedBaseUrl` resolves to a different
 * one (the object is reachable through both; either serving it un-sandboxed
 * defeats the gate). BYO lane: allowed when `ws.storageActiveContentVerifiedAt`
 * is within `LANE_STAMP_MAX_AGE_MS` (the unhealthy check above already
 * covers the "lane broke" case, so this branch is freshness only; a BYO
 * lane has no separate embed twin to check).
 *
 * Returns the reason alongside the verdict so the settings page can say
 * *why* SVG/XML are off without reimplementing any of this — a display that
 * could disagree with the gate is worse than no display.
 */
export async function activeContentStatus(
  env: Env,
  ws: WorkspaceRecord,
  now = new Date(),
): Promise<ActiveContentStatus> {
  if (ws.activeContentUploads === false) return { allowed: false, reason: "opted_out" };
  if (!env.FLAGS) return { allowed: false, reason: "flag_off" };
  try {
    if (!(await env.FLAGS.getBooleanValue(ACTIVE_CONTENT_FLAG, false))) {
      return { allowed: false, reason: "flag_off" };
    }
  } catch {
    return { allowed: false, reason: "flag_off" };
  }
  if (ws.storageUnhealthyAt) return { allowed: false, reason: "unhealthy" };
  if (isSharedLane(ws)) {
    // `REGISTRY` backs every workspace record too, so a real deployment
    // always has it bound — this guard exists so a caller/fixture that
    // wires up `FLAGS` without `REGISTRY` fails closed instead of throwing,
    // same fail-closed posture as the missing-`FLAGS` check above.
    if (!env.REGISTRY) return { allowed: false, reason: "host_missing" };
    const host = hostOf(ws.publicBaseUrl);
    if (!host) return { allowed: false, reason: "host_missing" };
    const stable = await hostStatus(env, host, now);
    if (!stable.allowed) return stable;
    // Same derivation `objectPublicUrls` (./storage.ts) uses for the embed
    // URL it hands every shared-lane caller — when it names a different
    // host than the stable one just checked, that host must be fresh and
    // `ok` too, or the object is still reachable un-sandboxed through it.
    const embedHost = hostOf(resolveEmbedBaseUrl(ws.publicBaseUrl, env.EMBED_PUBLIC_BASE_URL));
    if (embedHost && embedHost !== host) {
      const twin = await hostStatus(env, embedHost, now);
      if (!twin.allowed) return twin;
    }
    return stable;
  }
  if (!ws.storageActiveContentVerifiedAt) return { allowed: false, reason: "lane_missing" };
  return fresh(ws.storageActiveContentVerifiedAt, LANE_STAMP_MAX_AGE_MS, now)
    ? { allowed: true, verifiedAt: ws.storageActiveContentVerifiedAt }
    : { allowed: false, reason: "lane_stale" };
}

/** The gate itself — `activeContentStatus`'s verdict, for the callers that only decide admission. */
export async function activeContentAllowed(
  env: Env,
  ws: WorkspaceRecord,
  now = new Date(),
): Promise<boolean> {
  return (await activeContentStatus(env, ws, now)).allowed;
}
