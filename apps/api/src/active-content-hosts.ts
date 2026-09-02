/**
 * Daily probe of the hosted storage hosts for the SVG/XML sandboxing CSP
 * (issue #929, design doc "Lane state" / "Hosted lanes"). Ops sets the
 * `Content-Security-Policy: sandbox` + `X-Content-Type-Options: nosniff`
 * headers on each hosted custom domain via a Cloudflare zone Transform Rule
 * — this repo has no Worker in front of those domains and cannot set
 * response headers there itself. What it *can* do is probe: write an inert
 * SVG into the shared bucket, fetch it back through the public host, check
 * the headers, and record the result in KV so every workspace sharing that
 * host inherits the verdict (see `activeContentAllowed` in
 * `./active-content.ts`, which reads what this module writes).
 *
 * Invoked daily from the Worker `scheduled` handler (index.ts) and on demand
 * from `POST /admin-ui/active-content/probe`.
 */
import { DEFAULT_EMBED_PUBLIC_BASE_URL, DEFAULT_EMBEDDABLE_HOSTS } from "@uploads/storage";
import { SELF_SERVE_PUBLIC_BASE_URL } from "./self-serve-defaults";
import { ACTIVE_CONTENT_PROBE_SVG, checkActiveContentHeaders } from "./storage-verify";

/** KV `REGISTRY` record for one hosted host's most recent probe. No TTL — freshness is judged by the reader (`activeContentAllowed`). */
export interface HostActiveContentRecord {
  ok: boolean;
  verifiedAt: string;
  detail?: string;
}

/** KV key a host's probe result lives under in `REGISTRY`. */
export function hostActiveContentKey(host: string): string {
  return `host-active-content:${host}`;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Every hosted host the daily sweep covers, deduped: the shared bucket's
 * public host + its store twin (`DEFAULT_EMBEDDABLE_HOSTS`), the embed CDN
 * twin (`DEFAULT_EMBED_PUBLIC_BASE_URL`), and the host self-serve workspaces
 * are provisioned onto (`SELF_SERVE_PUBLIC_BASE_URL`) — on this deployment
 * that's the same host as the shared bucket's, but a self-hoster who
 * repoints either constant gets it swept automatically rather than needing
 * to edit this list too.
 */
export const HOSTED_ACTIVE_CONTENT_HOSTS: readonly string[] = (() => {
  const hosts = new Set<string>(DEFAULT_EMBEDDABLE_HOSTS);
  const embedHost = hostOf(DEFAULT_EMBED_PUBLIC_BASE_URL);
  if (embedHost) hosts.add(embedHost);
  const selfServeHost = hostOf(SELF_SERVE_PUBLIC_BASE_URL);
  if (selfServeHost) hosts.add(selfServeHost);
  return [...hosts];
})();

/**
 * The hosts to sweep for a given `env`: the static default set, plus an
 * `EMBED_PUBLIC_BASE_URL` override for a self-host that points the embed
 * twin somewhere else (`storage.ts` reads the same binding for the same
 * reason). Deduped.
 */
function hostsToSweep(env: Env): string[] {
  const hosts = new Set<string>(HOSTED_ACTIVE_CONTENT_HOSTS);
  if (env.EMBED_PUBLIC_BASE_URL) {
    const overrideHost = hostOf(env.EMBED_PUBLIC_BASE_URL);
    if (overrideHost) hosts.add(overrideHost);
  }
  return [...hosts];
}

/** Prefix the CSP-verify probe object lives under in the shared bucket. */
const CSP_PROBE_PREFIX = "_internal/uploads-csp-verify/";

/**
 * Probes one hosted host: writes `ACTIVE_CONTENT_PROBE_SVG` into
 * `env.UPLOADS_DEFAULT` under a fresh CSP-verify key, fetches it back
 * through `host`'s public URL, deletes the object (always — `finally`), and
 * persists the result to `REGISTRY`. Never throws: a write failure, a probe
 * failure, or a thrown fetch all resolve to an `ok: false` record with a
 * `detail`, which is exactly what `runActiveContentHostSweep` relies on to
 * keep one host's trouble from stopping the rest.
 */
export async function probeHostActiveContent(
  env: Env,
  host: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HostActiveContentRecord> {
  const key = `${CSP_PROBE_PREFIX}${crypto.randomUUID()}.svg`;
  let record: HostActiveContentRecord;
  try {
    await env.UPLOADS_DEFAULT.put(key, ACTIVE_CONTENT_PROBE_SVG, {
      httpMetadata: { contentType: "image/svg+xml" },
    });
    try {
      const check = await checkActiveContentHeaders(`https://${host}`, key, fetchImpl);
      record = {
        ok: check.ok,
        verifiedAt: new Date().toISOString(),
        ...(check.hint ? { detail: check.hint } : {}),
      };
    } finally {
      await env.UPLOADS_DEFAULT.delete(key).catch(() => {});
    }
  } catch (err) {
    record = {
      ok: false,
      verifiedAt: new Date().toISOString(),
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  await env.REGISTRY.put(hostActiveContentKey(host), JSON.stringify(record));
  return record;
}

/**
 * Probes every hosted host and writes each result to `REGISTRY`. One host's
 * probe blowing up (a thrown error `probeHostActiveContent` itself didn't
 * catch, e.g. the KV write) never stops the sweep from covering the rest —
 * that host just gets a synthesized `ok: false` record in the returned map
 * (best-effort; not re-persisted to KV if the KV write is what failed).
 */
export async function runActiveContentHostSweep(
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, HostActiveContentRecord>> {
  const results: Record<string, HostActiveContentRecord> = {};
  for (const host of hostsToSweep(env)) {
    try {
      results[host] = await probeHostActiveContent(env, host, fetchImpl);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results[host] = { ok: false, verifiedAt: new Date().toISOString(), detail };
      console.error(
        JSON.stringify({ message: "active_content_host_probe_failed", host, error: detail }),
      );
    }
  }
  return results;
}

/** Reads a hosted host's most recent probe record, or `null` if it has never been probed. */
export async function readHostActiveContent(
  env: Env,
  host: string,
): Promise<HostActiveContentRecord | null> {
  return (
    (await env.REGISTRY.get<HostActiveContentRecord>(hostActiveContentKey(host), "json")) ?? null
  );
}
