/**
 * ref → PR/issue title resolution with a KV cache (spec
 * .context/267-github-app-titles-design.md). Refs arrive already normalized
 * (`owner/repo#number`, lowercased) by the caller.
 *
 * Two ladders, chosen per ref by the caller's audience:
 *
 * - **public** (anyone, including anonymous `/f/` viewers): `ghref:pub:`
 *   cache → home-installation token, served only when the repo is verified
 *   public (`repoIsPrivate === false`) → negative cache. Never mints another
 *   installation's token, so a private repo's title is never resolved here.
 * - **member** (a workspace member, only for repos linked to that
 *   workspace): `ghref:` cache → home-installation token → the repo's own
 *   installation token (private repos) → negative cache.
 *
 * The App is installed across customer orgs, so `installationForRepo` can
 * read any installed repo regardless of who is asking. The member ladder is
 * therefore gated on `github_repo_links` (one workspace per repo, first
 * claim gated by GitHub write permission — github-claim-authz.ts). That
 * also makes the `ghref:` cache safe to share: only the linked workspace's
 * members ever read it. Refs for unlinked repos fall back to the public
 * ladder.
 */
import {
  githubAppConfig,
  githubFetch,
  githubHeaders,
  installationForRepo,
  installationToken,
  repoIsPrivate,
  type GithubAppConfig,
} from "./github-app";

/** Member-ladder cache (repo-linked workspace only). */
export const MEMBER_TITLE_PREFIX = "ghref:";
/** Public-ladder cache: entries resolved via the home installation for verified-public repos. */
export const PUBLIC_TITLE_PREFIX = "ghref:pub:";

/** Every cache key a ref's title can live under — webhook invalidation clears all of them. */
export function titleCacheKeys(ref: string): string[] {
  return [`${MEMBER_TITLE_PREFIX}${ref}`, `${PUBLIC_TITLE_PREFIX}${ref}`];
}

/**
 * Who the resolved titles are for. `public` never leaves the home
 * installation and only serves verified-public repos; `member` additionally
 * walks the repo's own installation, but only for `linkedRepos` (lowercased
 * `owner/name` bound to the caller's workspace) — other refs get the public
 * ladder.
 */
export type TitleAudience =
  | { audience: "public" }
  | { audience: "member"; linkedRepos: ReadonlySet<string> };

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

function splitRef(ref: string): { repo: string; num: string } {
  const hash = ref.lastIndexOf("#");
  return { repo: ref.slice(0, hash), num: ref.slice(hash + 1) };
}

async function readCache(env: Env, key: string): Promise<{ v: TitleInfo | null } | null> {
  return (await env.GITHUB_CACHE.get(key, "json")) as { v: TitleInfo | null } | null;
}

async function cacheOutcome(
  env: Env,
  key: string,
  outcome: FetchOutcome,
): Promise<TitleInfo | null> {
  if (outcome.kind === "ok") {
    const ttl = outcome.info.state === "open" ? OPEN_TTL : SETTLED_TTL;
    await env.GITHUB_CACHE.put(key, JSON.stringify({ v: outcome.info }), { expirationTtl: ttl });
    return outcome.info;
  }
  // "no-access" (404/private without install) and rate limits both
  // negative-cache so uninstalled repos don't hammer the API; transient
  // errors share the base 1h TTL — acceptable staleness for a display cache.
  const negativeTtl =
    outcome.kind === "error" && outcome.negativeTtl ? outcome.negativeTtl : NEGATIVE_TTL;
  await env.GITHUB_CACHE.put(key, JSON.stringify({ v: null }), { expirationTtl: negativeTtl });
  return null;
}

interface BatchContext {
  env: Env;
  cfg: GithubAppConfig | null;
  getHomeToken: () => Promise<string | null>;
  isPublicRepo: (repo: string) => Promise<boolean>;
  fetchImpl: typeof fetch;
}

/**
 * Public ladder: home installation only, and only for repos verified public.
 * A private repo the home installation happens to read (e.g. the home org's
 * own) is negative-cached here exactly like one it can't read.
 */
async function resolvePublic(ctx: BatchContext, ref: string): Promise<TitleInfo | null> {
  const { env, cfg } = ctx;
  const cacheKey = `${PUBLIC_TITLE_PREFIX}${ref}`;
  const cached = await readCache(env, cacheKey);
  if (cached) return cached.v;
  if (!cfg) return null; // App not configured — degrade without caching.

  // Home mint failure is transient and says nothing about the ref — don't
  // negative-cache it.
  const homeToken = await ctx.getHomeToken();
  if (!homeToken) return null;

  const { repo, num } = splitRef(ref);
  if (!(await ctx.isPublicRepo(repo))) return cacheOutcome(env, cacheKey, { kind: "no-access" });
  return cacheOutcome(env, cacheKey, await fetchIssue(repo, num, homeToken, ctx.fetchImpl));
}

/** Member ladder: home installation, then the repo's own installation. Caller gates on repo links. */
async function resolveMember(ctx: BatchContext, ref: string): Promise<TitleInfo | null> {
  const { env, cfg, fetchImpl } = ctx;
  const cacheKey = `${MEMBER_TITLE_PREFIX}${ref}`;
  const cached = await readCache(env, cacheKey);
  if (cached) return cached.v;
  if (!cfg) return null; // App not configured — degrade without caching.

  const { repo, num } = splitRef(ref);

  let outcome: FetchOutcome = { kind: "error" };
  const homeToken = await ctx.getHomeToken();
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

  return cacheOutcome(env, cacheKey, outcome);
}

/**
 * Cap live GitHub title resolve on public share/gallery JSON paths only.
 * `resolveTitles` can spend up to ~8s per hop; apps/web aborts at 4s.
 * Member-rail `/me` keeps the full resolve budget.
 */
export const PUBLIC_TITLE_RESOLVE_BUDGET_MS = 1400;

/** Race work against the public title budget; null on timeout (errors propagate). */
export async function withPublicTitleBudget<T>(
  work: Promise<T>,
  budgetMs: number = PUBLIC_TITLE_RESOLVE_BUDGET_MS,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Batch resolve; misses fetch concurrently; a per-ref failure is that ref's
 * `null`. `audience` is required so every caller states who will see the
 * result — see `TitleAudience`.
 */
export async function resolveTitles(
  env: Env,
  refs: string[],
  audience: TitleAudience,
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
  // Same sharing for repo visibility: several refs in one repo cost one
  // lookup. Only an explicit `false` counts as public — unknown fails closed.
  const privacy = new Map<string, Promise<boolean>>();
  const isPublicRepo = (repo: string): Promise<boolean> => {
    let pending = privacy.get(repo);
    if (!pending) {
      pending = cfg
        ? repoIsPrivate(env, cfg, Number(cfg.homeInstallationId), repo, fetchImpl).then(
            (isPrivate) => isPrivate === false,
            () => false,
          )
        : Promise.resolve(false);
      privacy.set(repo, pending);
    }
    return pending;
  };
  const ctx: BatchContext = { env, cfg, getHomeToken, isPublicRepo, fetchImpl };
  const out: Record<string, TitleInfo | null> = {};
  await Promise.all(
    refs.map(async (ref) => {
      const member = audience.audience === "member" && audience.linkedRepos.has(splitRef(ref).repo);
      out[ref] = await (member ? resolveMember(ctx, ref) : resolvePublic(ctx, ref)).catch(
        () => null,
      );
    }),
  );
  return out;
}
