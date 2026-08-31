/**
 * Verification pipeline for a candidate BYO R2 config (issue: self-serve
 * BYO R2 bucket, Task 1.1). Runs entirely against the request body — never
 * saved state — so a workspace admin can iterate before anything is
 * persisted. Modeled on `GithubHealthResult`
 * (`apps/api/src/routes/github-health.ts`): a list of per-check results with
 * a required/recommended split and a human `hint` on failure. `ok` is true
 * only when every *required* check passes; recommended checks never flip it.
 *
 * The storage client is injectable so tests never hit the network — the
 * default factory reuses `createStorage` from `@uploads/storage` (the same
 * seam `apps/api/src/storage.ts` resolves through), which picks the
 * files-sdk HTTP R2 adapter whenever no binding is supplied, exactly the
 * case here (self-serve BYO is HTTP-credential-mode only, see the plan's
 * Global Constraints).
 *
 * Never include credential values in any check result, hint, or log line.
 */
import {
  createStorage,
  isR2Jurisdiction,
  R2_JURISDICTIONS,
  type R2Jurisdiction,
  type StorageConfig,
} from "@uploads/storage";

/** Candidate config a workspace admin is trying to attach — not yet saved. */
export interface StorageVerifyCandidate {
  /** Defaults to `"r2"` when omitted. */
  provider?: "r2" | "s3";
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Custom domain fronting the bucket for public reads. Omit for signed-only serving. */
  publicBaseUrl?: string;
  /**
   * Caller has explicitly confirmed the bucket's existing contents should be
   * exposed under this workspace. Without it, a non-empty bucket fails the
   * empty-bucket guard (required check `not-empty`).
   */
  adoptExistingContents?: boolean;
  /** R2-only. Cloudflare account id. */
  accountId?: string;
  /** R2 jurisdiction of the bucket; validated by the shape check. Ignored for s3 candidates. */
  jurisdiction?: string;
  /** s3-only. Service endpoint origin, https, no path/query/fragment. */
  endpoint?: string;
  /** s3-only. SigV4 signing region. */
  region?: string;
  /** s3-only. Use path-style addressing. */
  forcePathStyle?: boolean;
}

export interface StorageVerifyCheck {
  /** Stable identifier — `"shape" | "auth" | "round-trip" | "not-empty" | "public-url" | "embed-cache"`. */
  id: string;
  ok: boolean;
  /** Required checks gate `StorageVerifyResult.ok`; recommended ones only ever warn. */
  required: boolean;
  /** Human remediation text, present when `ok` is false. */
  hint?: string;
  /**
   * True when the check could not actually run rather than failing — today
   * only the public-URL probe, when the fetch itself threw (any
   * Cloudflare-fronted custom domain is often unreachable as a Workers
   * subrequest even while it serves the public internet fine, issues
   * #783/#853). Callers that gate on a check should treat an inconclusive
   * result as "unknown", not "broken".
   */
  inconclusive?: boolean;
}

export interface StorageVerifyResult {
  /** True only when every required check passed. */
  ok: boolean;
  checks: StorageVerifyCheck[];
  /**
   * The jurisdiction the successful auth probe actually used — either the
   * candidate's own `jurisdiction` echoed back, or whichever of the
   * auto-probe order (default, `eu`, `fedramp`) answered first when the
   * caller omitted it. Absent when auth never succeeded. Callers that persist
   * a verified candidate (`storagePutHandler`) should save this value rather
   * than `candidate.jurisdiction` — that field is often unset by design now
   * that the wizard no longer shows a jurisdiction picker.
   */
  jurisdiction?: R2Jurisdiction;
}

/** Minimal surface the pipeline needs from a storage client — satisfied by files-sdk's `Files`. */
export interface StorageProbeClient {
  list(opts?: { prefix?: string; limit?: number }): Promise<{ items: { key: string }[] }>;
  upload(key: string, body: Uint8Array, opts?: { contentType?: string }): Promise<unknown>;
  download(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
  delete(key: string): Promise<void>;
}

/** Builds the real storage client for a candidate config. Swap in tests to avoid the network. */
export type StorageClientFactory = (candidate: StorageVerifyCandidate) => StorageProbeClient;

/** Default factory: routes through the same `createStorage` seam production I/O uses. */
export function defaultStorageClientFactory(candidate: StorageVerifyCandidate): StorageProbeClient {
  // `verifyStorageConfig` shape-checks before calling this, but the factory is
  // exported — re-guard so a direct caller can never interpolate an arbitrary
  // string into the S3 endpoint.
  if (candidate.provider === "s3") {
    const config: StorageConfig = {
      provider: "s3",
      bucket: candidate.bucket,
      endpoint: candidate.endpoint ?? "",
      region: candidate.region,
      forcePathStyle: candidate.forcePathStyle,
      accessKeyId: candidate.accessKeyId,
      secretAccessKey: candidate.secretAccessKey,
      publicBaseUrl: candidate.publicBaseUrl,
    };
    return createStorage(config);
  }
  const { jurisdiction } = candidate;
  if (jurisdiction !== undefined && !isR2Jurisdiction(jurisdiction)) {
    throw new Error(`invalid jurisdiction: ${JSON.stringify(jurisdiction)}`);
  }
  const config: StorageConfig = {
    provider: "r2",
    bucket: candidate.bucket,
    accountId: candidate.accountId,
    accessKeyId: candidate.accessKeyId,
    secretAccessKey: candidate.secretAccessKey,
    publicBaseUrl: candidate.publicBaseUrl,
    jurisdiction,
  };
  return createStorage(config);
}

export interface StorageVerifyOptions {
  /** Defaults to {@link defaultStorageClientFactory}. */
  createClient?: StorageClientFactory;
  /** Defaults to `globalThis.fetch`. Only used for the recommended public-URL probe. */
  fetch?: typeof fetch;
}

/** Prefix every verify probe object lives under, excluded from the empty-bucket count. */
const PROBE_PREFIX = "_internal/uploads-verify/";

/** Deadline for the recommended public-URL probe; a stalled customer domain must not stall verify. */
const PUBLIC_URL_PROBE_TIMEOUT_MS = 5_000;

const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;
/** R2 bucket naming rules: 3-63 chars, lowercase alphanumeric + hyphen, not leading/trailing hyphen. */
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
/** AWS S3 bucket naming rules: 3-63 chars, lowercase alphanumeric/dot/hyphen, must start and end alphanumeric. */
const S3_BUCKET_NAME_RE = /^[a-z0-9]([a-z0-9.-]{1,61})[a-z0-9]$/;
/** SigV4 region: lowercase alphanumeric/hyphen, up to 32 chars — allows literal "auto" (R2-compatible providers). */
const S3_REGION_RE = /^[a-z0-9-]{1,32}$/;

function checkShape(candidate: StorageVerifyCandidate): StorageVerifyCheck {
  const problems: string[] = [];
  const provider = candidate.provider ?? "r2";

  if (provider === "s3") {
    if (
      candidate.bucket.length < 3 ||
      candidate.bucket.length > 63 ||
      !S3_BUCKET_NAME_RE.test(candidate.bucket)
    ) {
      problems.push(
        "bucket name must be 3-63 characters, lowercase letters/digits/dots/hyphens, and can't start or end with a hyphen or dot",
      );
    }
    if (!candidate.endpoint) {
      problems.push("endpoint is required for an s3-compatible bucket");
    } else {
      const endpointProblem = checkEndpointShape(candidate.endpoint);
      if (endpointProblem) problems.push(endpointProblem);
    }
    if (!candidate.region) {
      problems.push("region is required for an s3-compatible bucket");
    } else if (!S3_REGION_RE.test(candidate.region)) {
      problems.push('region must match /^[a-z0-9-]{1,32}$/ (e.g. "us-east-1" or "auto")');
    }
  } else {
    if (!candidate.accountId || !ACCOUNT_ID_RE.test(candidate.accountId)) {
      problems.push("accountId must be a 32-character lowercase hex Cloudflare account id");
    }
    if (
      candidate.bucket.length < 3 ||
      candidate.bucket.length > 63 ||
      !BUCKET_NAME_RE.test(candidate.bucket)
    ) {
      problems.push(
        "bucket name must be 3-63 characters, lowercase letters/digits/hyphens, and can't start or end with a hyphen",
      );
    }
    if (candidate.jurisdiction !== undefined && !isR2Jurisdiction(candidate.jurisdiction)) {
      problems.push(
        `jurisdiction must be one of: ${R2_JURISDICTIONS.join(", ")} (or omitted for the default endpoint)`,
      );
    }
  }

  if (!candidate.accessKeyId || !candidate.secretAccessKey) {
    problems.push("access key id and secret access key are both required");
  }
  if (candidate.publicBaseUrl) {
    const urlProblem = checkPublicBaseUrlShape(candidate.publicBaseUrl);
    if (urlProblem) problems.push(urlProblem);
  }
  return {
    id: "shape",
    ok: problems.length === 0,
    required: true,
    hint: problems.length ? problems.join("; ") : undefined,
  };
}

/**
 * True when `host` looks like an internal name or literal address that must
 * never be reached from inside the worker — shared by the `publicBaseUrl`
 * shape check and the s3 `endpoint` shape check.
 */
function isInternalOrLiteralHost(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    !host.includes(".") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    host.startsWith("[")
  );
}

/** Shape-checks an s3 candidate's `endpoint`: https origin only, no path/query/fragment, public host. */
function checkEndpointShape(endpoint: string): string | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "endpoint must be a valid URL";
  }
  if (url.protocol !== "https:") {
    return "endpoint must use https";
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return "endpoint must not include a path";
  }
  if (url.search || url.hash) {
    return "endpoint must not include a query string or fragment";
  }
  const host = url.hostname.toLowerCase();
  if (isInternalOrLiteralHost(host)) {
    return "endpoint must be a public hostname (not an IP address or internal hostname)";
  }
  return undefined;
}

/**
 * `r2.dev` is rejected as a required failure (decided 2026-07-31 — not
 * supported in v1), not a warning; `*.uploads.sh` is rejected because it
 * would collide with the platform's own hosts.
 */
function checkPublicBaseUrlShape(publicBaseUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(publicBaseUrl);
  } catch {
    return "publicBaseUrl must be a valid URL";
  }
  if (url.protocol !== "https:") {
    return "publicBaseUrl must use https";
  }
  const host = url.hostname.toLowerCase();
  // Public custom domains only. The recommended probe fetches this host from
  // inside the worker, so anything that could resolve to an internal name or
  // literal address would turn verify into a reachability probe — reject
  // before any network I/O happens.
  if (isInternalOrLiteralHost(host)) {
    return "publicBaseUrl must be a public custom domain (not an IP address or internal hostname)";
  }
  if (host === "r2.dev" || host.endsWith(".r2.dev")) {
    return "r2.dev URLs aren't supported right now — connect a custom domain, or save without a public URL for signed-only access";
  }
  if (host === "uploads.sh" || host.endsWith(".uploads.sh")) {
    return "publicBaseUrl can't point at an uploads.sh host";
  }
  return undefined;
}

/** Duck-types files-sdk's `FilesError` without depending on the package directly (apps/api doesn't declare it). */
function errorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function hintForAuthError(err: unknown, provider: "r2" | "s3"): string {
  const scopedTo =
    provider === "s3"
      ? "an access key scoped to this bucket"
      : "the R2 API token is scoped to this bucket";
  switch (errorCode(err)) {
    case "Unauthorized":
      return `the access key was rejected — check the key id/secret and that ${scopedTo}`;
    case "NotFound":
      return provider === "s3"
        ? "bucket not found at this endpoint — check the bucket name for typos"
        : "bucket not found at this account id — check the bucket name for typos";
    default:
      return provider === "s3"
        ? "could not reach the bucket — check the endpoint, bucket name, and network path"
        : "could not reach the bucket — check the account id, bucket name, and network path";
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Recommended, non-blocking check: fetch the still-live probe object via the
 * candidate's public base URL and byte-compare against what was written.
 * Never runs when there's no `publicBaseUrl` (signed-only mode is valid) or
 * when the round-trip failed (no probe object to fetch).
 */
async function checkPublicUrl(
  publicBaseUrl: string,
  probeKey: string,
  probeBytes: Uint8Array,
  fetchImpl: typeof fetch,
): Promise<{ check: StorageVerifyCheck; cacheControl: string | null | undefined }> {
  const url = `${publicBaseUrl.replace(/\/$/, "")}/${probeKey}`;
  try {
    const res = await fetchImpl(url, {
      // NOT `redirect: "error"`: local workerd (wrangler dev) throws a
      // synchronous TypeError for that value — it's simply unimplemented
      // there ("won't be implemented since it does not make sense at the
      // edge"), unrelated to the timeout below. Prod's real edge fetch does
      // support it, so this was silently turning every local probe into the
      // thrown-fetch/inconclusive branch. `"manual"` is supported
      // everywhere (local and prod): it hands back the 3xx response
      // un-followed instead of throwing, so the existing `!res.ok` branch
      // below already fails a redirecting domain — same "never verified"
      // outcome as `"error"`, just via a normal failed check instead of an
      // inconclusive one.
      redirect: "manual",
      signal: AbortSignal.timeout(PUBLIC_URL_PROBE_TIMEOUT_MS),
    });
    // Read the header before consuming the body: the embed-cache check
    // (below) only makes sense when the domain actually answered, so the
    // reading rides along with whichever public-url outcome this is.
    const cacheControl = res.headers.get("cache-control");
    if (!res.ok) {
      const isRedirect = res.status >= 300 && res.status < 400;
      return {
        check: {
          id: "public-url",
          ok: false,
          required: false,
          hint: isRedirect
            ? `fetching the probe object via publicBaseUrl redirected (HTTP ${res.status}) instead of serving it directly — connect a domain that serves the bucket without redirecting, or fix the redirect rule`
            : `fetching the probe object via publicBaseUrl returned HTTP ${res.status} — the domain may be connected to a different bucket, or public access isn't enabled yet`,
        },
        cacheControl: undefined,
      };
    }
    const body = new Uint8Array(await res.arrayBuffer());
    if (!bytesEqual(body, probeBytes)) {
      return {
        check: {
          id: "public-url",
          ok: false,
          required: false,
          hint: "the bytes served from publicBaseUrl didn't match what was just written — this can mean a cached/stale response from an edge in front of the domain rather than a wiring problem; try again in a minute",
        },
        cacheControl,
      };
    }
    return { check: { id: "public-url", ok: true, required: false }, cacheControl };
  } catch {
    // A thrown fetch means this probe — run from inside the API worker —
    // couldn't reach the domain; it does NOT mean the domain is broken. Any
    // Cloudflare-fronted custom domain can be unreachable as a Workers
    // subrequest while serving the public internet fine — not just a
    // same-account one, per issue #853. Say "we couldn't verify it from
    // here", not "your domain is broken", and point at the one check that
    // actually settles it.
    return {
      check: {
        id: "public-url",
        ok: false,
        required: false,
        inconclusive: true,
        hint: "we couldn't verify publicBaseUrl from here — this can happen even when the domain is working fine (Cloudflare-fronted custom domains often aren't reachable as a server-side request). Open a known object's URL in a browser to check for yourself; if that loads, the domain is fine.",
      },
      cacheControl: undefined,
    };
  }
}

/**
 * Recommended, non-blocking check (issue #592): whether the custom domain
 * serves the badge-style no-cache headers GitHub's Camo proxy needs to
 * revalidate an image after an in-place overwrite — the same Transform Rule
 * `embed.uploads.sh` carries on hosted storage. Only emitted when the
 * public-URL probe actually got a response; `null` (header absent) counts as
 * missing. `no-store` or `no-cache` in Cache-Control is what makes Camo
 * refetch reliably; a plain short max-age is not enough (issue #152).
 */
function checkEmbedCache(cacheControl: string | null): StorageVerifyCheck {
  const value = (cacheControl ?? "").toLowerCase();
  const ok = value.includes("no-store") || value.includes("no-cache");
  return {
    id: "embed-cache",
    ok,
    required: false,
    hint: ok
      ? undefined
      : 'optional but recommended: add a Cloudflare Transform Rule on this domain setting Cache-Control to "max-age=0, no-cache, no-store, must-revalidate" so GitHub embeds refresh when a file is overwritten in place — see the setup guide (/docs/byo-bucket)',
  };
}

/** Warning shown when no `publicBaseUrl` is configured — signed-only mode is allowed but degraded (issue #783 follow-up comment). */
const NO_PUBLIC_URL_HINT =
  "no public base URL set — files will only be reachable through signed links that expire after an hour, and embeds/galleries won't work. Add one any time; it applies retroactively to files already uploaded (URLs are derived on request, nothing is stored per file).";

/**
 * Runs the required + recommended check pipeline against `candidate`.
 * Required checks short-circuit on first failure (shape → auth → round-trip
 * → not-empty). When `candidate.jurisdiction` is omitted, the auth step
 * auto-probes the default endpoint, then `eu`, then `fedramp`, and records
 * whichever answers on `StorageVerifyResult.jurisdiction`. The public-URL
 * check always runs last: a real reachability probe when `publicBaseUrl` is
 * set (recommended — never gates `ok`), otherwise a recommended warning that
 * signed-only mode is a degraded, not neutral, choice.
 */
export async function verifyStorageConfig(
  candidate: StorageVerifyCandidate,
  opts: StorageVerifyOptions = {},
): Promise<StorageVerifyResult> {
  const createClient = opts.createClient ?? defaultStorageClientFactory;
  const fetchImpl = opts.fetch ?? fetch;
  const checks: StorageVerifyCheck[] = [];

  const shape = checkShape(candidate);
  checks.push(shape);
  if (!shape.ok) return { ok: false, checks };

  // Auth + reachability probe, also resolving the jurisdiction. When the
  // caller supplied one explicitly (parsed from a pasted endpoint URL), just
  // use it — one client, one attempt. Otherwise auto-probe in the order the
  // wizard promises (default endpoint, then `eu`, then `fedramp`) and use
  // whichever answers first; a wrong-jurisdiction bucket reliably fails
  // auth/lookup at the other endpoints, so trying in order costs at most two
  // extra calls and never a false positive. Its `list()` result also seeds
  // the empty-bucket guard below, so attaching a bucket costs one list call.
  // s3 candidates have no jurisdiction concept — one client, one attempt.
  const provider = candidate.provider ?? "r2";
  const jurisdictionOrder: (R2Jurisdiction | undefined)[] =
    provider === "s3"
      ? [undefined]
      : candidate.jurisdiction !== undefined
        ? [candidate.jurisdiction as R2Jurisdiction]
        : [undefined, ...R2_JURISDICTIONS];

  let client: StorageProbeClient | undefined;
  let existingItems: { key: string }[] | undefined;
  let jurisdiction: R2Jurisdiction | undefined;
  let authErr: unknown;
  for (const attemptJurisdiction of jurisdictionOrder) {
    const attemptClient = createClient(
      provider === "s3" ? candidate : { ...candidate, jurisdiction: attemptJurisdiction },
    );
    try {
      const listed = await attemptClient.list({ limit: 1000 });
      client = attemptClient;
      existingItems = listed.items;
      jurisdiction = attemptJurisdiction;
      break;
    } catch (err) {
      authErr = err;
    }
  }

  if (!client || !existingItems) {
    checks.push({
      id: "auth",
      ok: false,
      required: true,
      hint: hintForAuthError(authErr, provider),
    });
    return { ok: false, checks };
  }
  checks.push({ id: "auth", ok: true, required: true });

  // Write/read/delete round-trip, plus (while the probe object is still
  // live) the recommended public-URL fetch. The probe is always removed in
  // `finally`, whether or not the checks above it passed.
  const probeKey = `${PROBE_PREFIX}${crypto.randomUUID()}`;
  const probeBytes = crypto.getRandomValues(new Uint8Array(32));
  let roundTripOk = false;
  let roundTripHint: string | undefined;
  let publicUrlCheck: StorageVerifyCheck | undefined;
  let publicUrlCacheControl: string | null | undefined;
  try {
    await client.upload(probeKey, probeBytes, { contentType: "application/octet-stream" });
    const downloaded = await client.download(probeKey);
    const readBack = new Uint8Array(await downloaded.arrayBuffer());
    roundTripOk = bytesEqual(probeBytes, readBack);
    if (!roundTripOk) {
      roundTripHint =
        "wrote and read back a probe object but the bytes didn't match — check for another writer racing this bucket";
    } else if (candidate.publicBaseUrl) {
      const probed = await checkPublicUrl(candidate.publicBaseUrl, probeKey, probeBytes, fetchImpl);
      publicUrlCheck = probed.check;
      publicUrlCacheControl = probed.cacheControl;
    }
  } catch (err) {
    if (errorCode(err) === "Unauthorized") {
      roundTripHint =
        provider === "s3"
          ? "the access key can read this bucket but was rejected on write — the access key needs write permissions, not just read"
          : "the access key can read this bucket but was rejected on write — the R2 API token needs Object Read & Write, not read-only";
    } else {
      roundTripHint =
        "could not write/read/delete a test object in this bucket — check the token's permissions";
    }
  } finally {
    try {
      await client.delete(probeKey);
    } catch {
      // Best-effort cleanup; a failed delete doesn't change the check result
      // above (round-trip already recorded), and we never want cleanup
      // failure to mask the real outcome.
    }
  }
  checks.push({
    id: "round-trip",
    ok: roundTripOk,
    required: true,
    hint: roundTripOk ? undefined : roundTripHint,
  });

  const nonProbeItems = existingItems.filter((item) => !item.key.startsWith(PROBE_PREFIX));
  const notEmptyOk = candidate.adoptExistingContents === true || nonProbeItems.length === 0;
  checks.push({
    id: "not-empty",
    ok: notEmptyOk,
    required: true,
    hint: notEmptyOk
      ? undefined
      : "this bucket already has objects in it. Nothing gets imported or copied — the bucket root simply becomes this workspace's root, so every existing object becomes visible here (and publicly reachable too, if you set a public base URL) once you switch to this bucket. Confirm that's what you want (adoptExistingContents), or point at an empty bucket instead. Saving now doesn't switch anything on its own — you do that separately, whenever you're ready.",
  });

  if (candidate.publicBaseUrl) {
    checks.push(
      publicUrlCheck ?? {
        id: "public-url",
        ok: false,
        required: false,
        hint: "skipped — the write/read round-trip failed before the public URL could be verified",
      },
    );
    // Cache-rule reading for GitHub embeds (issue #592) — only when the
    // domain answered, so the check never piles "couldn't check" noise on
    // top of an unreachable-domain public-url failure.
    if (publicUrlCacheControl !== undefined) {
      checks.push(checkEmbedCache(publicUrlCacheControl));
    }
  } else {
    // Signed-only mode is allowed, but it's a degraded state, not a neutral
    // default — flag it the same warning-level way a failed recommended
    // check would be (issue #783 follow-up comment).
    checks.push({ id: "public-url", ok: false, required: false, hint: NO_PUBLIC_URL_HINT });
  }

  return {
    ok: checks.filter((c) => c.required).every((c) => c.ok),
    checks,
    jurisdiction,
  };
}
