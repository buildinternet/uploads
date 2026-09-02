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
 */
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

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True when `iso` parses and is within `maxAgeMs` of `now`. Absent/unparseable is never fresh. */
function fresh(iso: string | undefined, maxAgeMs: number, now: Date): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t <= maxAgeMs;
}

/**
 * Every gate, cheapest first: workspace opt-out, missing/disabled/thrown
 * Flagship flag, a lane currently flagged unhealthy (issue #826 — a
 * struggling BYO lane never gets active-content treated as a new problem to
 * diagnose), then the lane-specific freshness check.
 *
 * Shared lane: reads `REGISTRY`'s `host-active-content:<host>` record (see
 * `./active-content-hosts.ts`, written by the daily cron/admin probe) for
 * the hostname of `ws.publicBaseUrl` — allowed when it exists, passed, and
 * is within `HOST_RECORD_MAX_AGE_MS`. BYO lane: allowed when
 * `ws.storageActiveContentVerifiedAt` is within `LANE_STAMP_MAX_AGE_MS`
 * (the unhealthy check above already covers the "lane broke" case, so this
 * branch is freshness only).
 */
export async function activeContentAllowed(
  env: Env,
  ws: WorkspaceRecord,
  now = new Date(),
): Promise<boolean> {
  if (ws.activeContentUploads === false) return false;
  if (!env.FLAGS) return false;
  try {
    if (!(await env.FLAGS.getBooleanValue(ACTIVE_CONTENT_FLAG, false))) return false;
  } catch {
    return false;
  }
  if (ws.storageUnhealthyAt) return false;
  if (isSharedLane(ws)) {
    // `REGISTRY` backs every workspace record too, so a real deployment
    // always has it bound — this guard exists so a caller/fixture that
    // wires up `FLAGS` without `REGISTRY` fails closed instead of throwing,
    // same fail-closed posture as the missing-`FLAGS` check above.
    if (!env.REGISTRY) return false;
    const host = hostOf(ws.publicBaseUrl);
    if (!host) return false;
    const record = await readHostActiveContent(env, host);
    return !!record && record.ok && fresh(record.verifiedAt, HOST_RECORD_MAX_AGE_MS, now);
  }
  return fresh(ws.storageActiveContentVerifiedAt, LANE_STAMP_MAX_AGE_MS, now);
}
