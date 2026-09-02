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
 * A shared-lane workspace's object is reachable through *several* hosts, not
 * one: the shared bucket carries more than one custom domain (`storage.` and
 * `store.uploads.sh` are the same bucket, same keys, same bytes), and
 * `objectPublicUrls` (`./storage.ts`) also hands out the `embed.uploads.sh`
 * twin (`resolveEmbedBaseUrl`, same `@uploads/storage` helper). Any one of
 * them serving the object un-sandboxed defeats the gate, so the shared-lane
 * branch below requires a fresh `ok` record for *every* hosted host the
 * daily sweep covers (`HOSTED_ACTIVE_CONTENT_HOSTS`), plus this workspace's
 * own host and its embed twin — not just the two the workspace's URLs name.
 */
import { hostOf, resolveEmbedBaseUrl } from "@uploads/storage";
import { isSharedLane } from "./storage";
import { HOSTED_ACTIVE_CONTENT_HOSTS, readHostActiveContent } from "./active-content-hosts";
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
  | "host_not_ok"
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
  /** For a `host_*` reason, the hosted host whose record closed the gate — the sweep covers several, and "which one" is the first thing an operator asks. */
  host?: string;
}

/** One hosted host's KV record as a status: fresh and `ok` allows; anything else says why not. */
async function hostStatus(env: Env, host: string, now: Date): Promise<ActiveContentStatus> {
  const record = await readHostActiveContent(env, host);
  if (!record) return { allowed: false, reason: "host_missing" };
  if (!record.ok) return { allowed: false, reason: "host_not_ok" };
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
 * Shared lane: reads `REGISTRY`'s `host-active-content:<host>` records (see
 * `./active-content-hosts.ts`, written by the daily cron/admin probe) for
 * every host that can serve a shared-bucket object — the sweep's own set
 * (`HOSTED_ACTIVE_CONTENT_HOSTS`: the shared bucket's custom domains, the
 * embed twin, the self-serve host), plus this workspace's `publicBaseUrl`
 * host and the twin `resolveEmbedBaseUrl` derives for it, deduped and read
 * in parallel. Allowed only when *every* one of those records exists,
 * passed, and is within `HOST_RECORD_MAX_AGE_MS`; the first that isn't names
 * itself in `host`. BYO lane: allowed when `ws.storageActiveContentVerifiedAt`
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
    // The sweep's own host set first (so a `store.uploads.sh` whose rule was
    // never applied — or was pulled later — closes the gate for every
    // workspace on the shared bucket, not just the ones whose URLs name it),
    // then this workspace's own host, then the embed twin
    // `objectPublicUrls` (./storage.ts) hands every shared-lane caller.
    // Deduped: on this deployment most of these collapse to two hosts.
    const hosts = new Set<string>(HOSTED_ACTIVE_CONTENT_HOSTS);
    hosts.add(host);
    const embedHost = hostOf(resolveEmbedBaseUrl(ws.publicBaseUrl, env.EMBED_PUBLIC_BASE_URL));
    if (embedHost) hosts.add(embedHost);
    // In parallel — a handful of independent KV reads, and a shared-lane put
    // waits on all of them.
    const checked = await Promise.all(
      [...hosts].map(async (h) => [h, await hostStatus(env, h, now)] as const),
    );
    const failed = checked.find(([, status]) => !status.allowed);
    if (failed) return { ...failed[1], host: failed[0] };
    // Every host passed; report the workspace's own host's timestamp, the
    // one a settings page means by "verified".
    return checked.find(([h]) => h === host)![1];
  }
  if (!ws.storageActiveContentVerifiedAt) return { allowed: false, reason: "lane_missing" };
  return fresh(ws.storageActiveContentVerifiedAt, LANE_STAMP_MAX_AGE_MS, now)
    ? { allowed: true, verifiedAt: ws.storageActiveContentVerifiedAt }
    : { allowed: false, reason: "lane_stale" };
}

/**
 * The reasons a *server-side copy* of bytes already stored in this workspace
 * tolerates (issue #929 adversarial review M-2). All five are freshness
 * reasons: a host record that has gone stale, failed, or was never written,
 * or a BYO lane stamp that lapsed. None of them says the object shouldn't
 * exist — the bytes are already sitting on this same lane, served by this
 * same host — so refusing the copy would make a stored SVG uncopyable the
 * moment verification lapsed and would wedge private-prefix rotation
 * outright, without removing anything from the internet.
 *
 * The three that are NOT here are policy, not freshness: `opted_out`,
 * `flag_off` and `unhealthy` are somebody deciding this workspace (or the
 * whole platform) should stop taking gated types. A kill switch that new
 * copies can walk straight past is not a kill switch, so those deny — and
 * the batch copy paths (`github-promote.ts`,
 * `github-private-prefix-service.ts`) skip the individual object rather than
 * failing the whole batch.
 */
const COPY_TOLERATED_REASONS: ReadonlySet<ActiveContentReason> = new Set([
  "host_missing",
  "host_not_ok",
  "host_stale",
  "lane_missing",
  "lane_stale",
]);

/**
 * The gate as a server-side copy sees it: `activeContentStatus`'s verdict,
 * widened by {@link COPY_TOLERATED_REASONS}. Used only by `putObject`'s
 * `serverCopy` path.
 */
export async function activeContentAllowedForCopy(
  env: Env,
  ws: WorkspaceRecord,
  now = new Date(),
): Promise<boolean> {
  const status = await activeContentStatus(env, ws, now);
  return (
    status.allowed || (status.reason !== undefined && COPY_TOLERATED_REASONS.has(status.reason))
  );
}

/** The gate itself — `activeContentStatus`'s verdict, for the callers that only decide admission. */
export async function activeContentAllowed(
  env: Env,
  ws: WorkspaceRecord,
  now = new Date(),
): Promise<boolean> {
  return (await activeContentStatus(env, ws, now)).allowed;
}
