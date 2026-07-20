/**
 * ref → PR/issue title resolution with a KV cache (spec
 * .context/267-github-app-titles-design.md). Ladder per ref: ghref cache →
 * home-installation token (public repos, one 5k/hr bucket) → the repo's own
 * installation token (private repos) → negative cache. Refs arrive already
 * normalized (`owner/repo#number`, lowercased) by the caller.
 */
import {
  githubAppConfig,
  githubFetch,
  githubHeaders,
  installationForRepo,
  installationToken,
  type GithubAppConfig,
} from "./github-app";

export interface TitleInfo {
  title: string;
  state: "open" | "closed" | "merged";
  kind: "pull" | "issue";
}

const OPEN_TTL = 3600;
const SETTLED_TTL = 86400;
const NEGATIVE_TTL = 3600;
/** Slack added past the rate-limit reset so the retry lands after it. */
const RESET_SLACK = 60;

type FetchOutcome =
  | { kind: "ok"; info: TitleInfo }
  | { kind: "no-access" }
  | { kind: "error"; negativeTtl?: number };

async function fetchIssue(
  repo: string,
  num: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<FetchOutcome> {
  let res: Response;
  try {
    res = await githubFetch(fetchImpl, `https://api.github.com/repos/${repo}/issues/${num}`, {
      headers: githubHeaders(token),
    });
  } catch {
    return { kind: "error" };
  }
  if (res.ok) {
    const body = (await res.json().catch(() => null)) as {
      title?: string;
      state?: string;
      pull_request?: { merged_at?: string | null };
    } | null;
    // A 2xx with an unparseable/malformed body is treated like a transient
    // error: negative-cached at the base TTL so a misbehaving upstream isn't
    // re-fetched per paint, and retried once the entry expires.
    if (!body || typeof body.title !== "string") return { kind: "error" };
    const kind: TitleInfo["kind"] = body.pull_request ? "pull" : "issue";
    const state: TitleInfo["state"] =
      body.state === "closed" ? (body.pull_request?.merged_at ? "merged" : "closed") : "open";
    return { kind: "ok", info: { title: body.title, state, kind } };
  }
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const until = Number.isFinite(reset) ? reset - Math.floor(Date.now() / 1000) : 0;
    return { kind: "error", negativeTtl: Math.max(NEGATIVE_TTL, until + RESET_SLACK) };
  }
  if (res.status === 404 || res.status === 403 || res.status === 401) return { kind: "no-access" };
  return { kind: "error" };
}

async function resolveOne(
  env: Env,
  cfg: GithubAppConfig | null,
  ref: string,
  getHomeToken: () => Promise<string | null>,
  fetchImpl: typeof fetch,
): Promise<TitleInfo | null> {
  const cacheKey = `ghref:${ref}`;
  const cached = (await env.GITHUB_CACHE.get(cacheKey, "json")) as { v: TitleInfo | null } | null;
  if (cached) return cached.v;
  if (!cfg) return null; // App not configured — degrade without caching.

  const hash = ref.lastIndexOf("#");
  const repo = ref.slice(0, hash);
  const num = ref.slice(hash + 1);

  let negativeTtl = NEGATIVE_TTL;
  let outcome: FetchOutcome = { kind: "error" };
  const homeToken = await getHomeToken();
  if (homeToken) outcome = await fetchIssue(repo, num, homeToken, fetchImpl);

  // Retry via the repo's own installation on no-access, and also when the
  // home token itself failed to mint (transient blip) — otherwise a ref with
  // a perfectly good cached installation would be negative-cached for an
  // hour because of an unrelated home-token failure.
  if (outcome.kind === "no-access" || homeToken === null) {
    const installId = await installationForRepo(env, cfg, repo, fetchImpl);
    if (installId !== null) {
      const instToken = await installationToken(env, cfg, installId, fetchImpl);
      if (instToken) outcome = await fetchIssue(repo, num, instToken, fetchImpl);
    }
  }

  if (outcome.kind === "ok") {
    const ttl = outcome.info.state === "open" ? OPEN_TTL : SETTLED_TTL;
    await env.GITHUB_CACHE.put(cacheKey, JSON.stringify({ v: outcome.info }), {
      expirationTtl: ttl,
    });
    return outcome.info;
  }
  if (outcome.kind === "error" && outcome.negativeTtl) negativeTtl = outcome.negativeTtl;
  // "no-access" (404/private without install) and rate limits both
  // negative-cache so uninstalled repos don't hammer the API; transient
  // errors share the base 1h TTL — acceptable staleness for a display cache.
  await env.GITHUB_CACHE.put(cacheKey, JSON.stringify({ v: null }), {
    expirationTtl: negativeTtl,
  });
  return null;
}

/** Batch resolve; misses fetch concurrently; a per-ref failure is that ref's `null`. */
export async function resolveTitles(
  env: Env,
  refs: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, TitleInfo | null>> {
  const cfg = githubAppConfig(env);
  // One home-token resolution shared (and lazily started) across the whole
  // batch: without this, N cache-missing refs would each read the same
  // `ghtok:` key and — on a cold cache — race N concurrent JWT signs and
  // token mints against GitHub. Lazy so an all-cache-hit batch stays free.
  let homeTokenPromise: Promise<string | null> | undefined;
  const getHomeToken = (): Promise<string | null> =>
    (homeTokenPromise ??= cfg
      ? installationToken(env, cfg, Number(cfg.homeInstallationId), fetchImpl)
      : Promise.resolve(null));
  const out: Record<string, TitleInfo | null> = {};
  await Promise.all(
    refs.map(async (ref) => {
      out[ref] = await resolveOne(env, cfg, ref, getHomeToken, fetchImpl).catch(() => null);
    }),
  );
  return out;
}
