/**
 * Daily probe of the hosted storage hosts for the SVG/XML sandboxing CSP
 * (issue #929, design doc "Lane state" / "Hosted lanes"). Ops sets the
 * `Content-Security-Policy: sandbox` + `X-Content-Type-Options: nosniff`
 * headers on each hosted custom domain via a Cloudflare zone Transform Rule
 * — this repo has no Worker in front of those domains and cannot set
 * response headers there itself. What it *can* do is probe: write an inert
 * SVG into the shared bucket, fetch it back through the public host, check
 * the headers, and record the result in KV so every workspace sharing that
 * host inherits the verdict (see `activeContentStatus` in
 * `./active-content.ts`, which reads what this module writes).
 *
 * Invoked daily from the Worker `scheduled` handler (index.ts) and on demand
 * from `POST /admin-ui/active-content/probe`.
 */
import { DEFAULT_EMBED_PUBLIC_BASE_URL, DEFAULT_EMBEDDABLE_HOSTS, hostOf } from "@uploads/storage";
import { SELF_SERVE_PUBLIC_BASE_URL } from "./self-serve-defaults";
import { probeActiveContent } from "./storage-verify";

/** KV `REGISTRY` record for one hosted host's most recent probe. No TTL — freshness is judged by the reader (`activeContentStatus`). */
export interface HostActiveContentRecord {
  ok: boolean;
  verifiedAt: string;
  detail?: string;
}

/** KV key a host's probe result lives under in `REGISTRY`. */
export function hostActiveContentKey(host: string): string {
  return `host-active-content:${host}`;
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

/**
 * The two methods `probeActiveContent` needs, over an R2 binding — the
 * hosted hosts are served straight out of the platform's own bucket, so
 * there is no HTTP storage client here the way a BYO lane has one.
 */
function bucketProbeClient(bucket: R2Bucket) {
  return {
    upload: (key: string, body: Uint8Array, opts?: { contentType?: string }) =>
      bucket.put(key, body, { httpMetadata: { contentType: opts?.contentType } }),
    delete: async (key: string) => {
      await bucket.delete(key);
    },
  };
}

/**
 * Probes one hosted host through the shared `probeActiveContent` (write the
 * inert SVG into `env.UPLOADS_DEFAULT`, fetch it back through `host`'s
 * public URL, delete it) and persists the verdict to `REGISTRY`. Never
 * throws: a write failure, a header failure, and a thrown fetch all resolve
 * to an `ok: false` record with a `detail`, which is what
 * `runActiveContentHostSweep` relies on to keep one host's trouble from
 * stopping the rest.
 */
export async function probeHostActiveContent(
  env: Env,
  host: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HostActiveContentRecord> {
  const check = await probeActiveContent(
    bucketProbeClient(env.UPLOADS_DEFAULT),
    `https://${host}`,
    fetchImpl,
  );
  const record: HostActiveContentRecord = {
    ok: check.ok,
    verifiedAt: new Date().toISOString(),
    ...(check.hint ? { detail: check.hint } : {}),
  };
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
  // In parallel: each probe already catches its own failures, the set is a
  // handful of hosts, and a slow or hanging host shouldn't hold up the rest
  // of a cron run.
  const entries = await Promise.all(
    hostsToSweep(env).map(async (host): Promise<[string, HostActiveContentRecord]> => {
      try {
        return [host, await probeHostActiveContent(env, host, fetchImpl)];
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(
          JSON.stringify({ message: "active_content_host_probe_failed", host, error: detail }),
        );
        return [host, { ok: false, verifiedAt: new Date().toISOString(), detail }];
      }
    }),
  );
  return Object.fromEntries(entries);
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
