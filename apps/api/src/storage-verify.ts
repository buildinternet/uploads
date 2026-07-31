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
  R2_JURISDICTIONS,
  type R2Jurisdiction,
  type StorageConfig,
} from "@uploads/storage";

/** Candidate config a workspace admin is trying to attach — not yet saved. */
export interface StorageVerifyCandidate {
  bucket: string;
  accountId: string;
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
  /** R2 jurisdiction of the bucket; validated by the shape check. */
  jurisdiction?: string;
}

export interface StorageVerifyCheck {
  /** Stable identifier — `"shape" | "auth" | "round-trip" | "not-empty" | "public-url"`. */
  id: string;
  ok: boolean;
  /** Required checks gate `StorageVerifyResult.ok`; recommended ones only ever warn. */
  required: boolean;
  /** Human remediation text, present when `ok` is false. */
  hint?: string;
}

export interface StorageVerifyResult {
  /** True only when every required check passed. */
  ok: boolean;
  checks: StorageVerifyCheck[];
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
  const config: StorageConfig = {
    provider: "r2",
    bucket: candidate.bucket,
    accountId: candidate.accountId,
    accessKeyId: candidate.accessKeyId,
    secretAccessKey: candidate.secretAccessKey,
    publicBaseUrl: candidate.publicBaseUrl,
    // Safe: this factory only ever runs after `checkShape` has validated
    // `jurisdiction` against R2_JURISDICTIONS (verifyStorageConfig short-
    // circuits on shape failure before calling the factory).
    jurisdiction: candidate.jurisdiction as R2Jurisdiction | undefined,
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

function checkShape(candidate: StorageVerifyCandidate): StorageVerifyCheck {
  const problems: string[] = [];
  if (!ACCOUNT_ID_RE.test(candidate.accountId)) {
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
  if (!candidate.accessKeyId || !candidate.secretAccessKey) {
    problems.push("access key id and secret access key are both required");
  }
  if (candidate.publicBaseUrl) {
    const urlProblem = checkPublicBaseUrlShape(candidate.publicBaseUrl);
    if (urlProblem) problems.push(urlProblem);
  }
  if (
    candidate.jurisdiction !== undefined &&
    !(R2_JURISDICTIONS as readonly string[]).includes(candidate.jurisdiction)
  ) {
    problems.push(
      `jurisdiction must be one of: ${R2_JURISDICTIONS.join(", ")} (or omitted for the default endpoint)`,
    );
  }
  return {
    id: "shape",
    ok: problems.length === 0,
    required: true,
    hint: problems.length ? problems.join("; ") : undefined,
  };
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
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    !host.includes(".") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    host.startsWith("[")
  ) {
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

function hintForAuthError(err: unknown): string {
  switch (errorCode(err)) {
    case "Unauthorized":
      return "the access key was rejected — check the key id/secret and that the R2 API token is scoped to this bucket";
    case "NotFound":
      return "bucket not found at this account id — check the bucket name for typos";
    default:
      return "could not reach the bucket — check the account id, bucket name, and network path";
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
): Promise<StorageVerifyCheck> {
  const url = `${publicBaseUrl.replace(/\/$/, "")}/${probeKey}`;
  try {
    const res = await fetchImpl(url, {
      redirect: "error",
      signal: AbortSignal.timeout(PUBLIC_URL_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        id: "public-url",
        ok: false,
        required: false,
        hint: `fetching the probe object via publicBaseUrl returned HTTP ${res.status} — the domain may be connected to a different bucket, or public access isn't enabled yet`,
      };
    }
    const body = new Uint8Array(await res.arrayBuffer());
    if (!bytesEqual(body, probeBytes)) {
      return {
        id: "public-url",
        ok: false,
        required: false,
        hint: "the bytes served from publicBaseUrl didn't match what was just written — this can mean a cached/stale response from an edge in front of the domain rather than a wiring problem; try again in a minute",
      };
    }
    return { id: "public-url", ok: true, required: false };
  } catch {
    return {
      id: "public-url",
      ok: false,
      required: false,
      hint: "could not reach publicBaseUrl — domain not connected to the bucket yet (DNS can take a few minutes) or the request timed out",
    };
  }
}

/**
 * Runs the required + recommended check pipeline against `candidate`.
 * Required checks short-circuit on first failure (shape → auth → round-trip
 * → not-empty); the recommended public-URL check only runs when the
 * round-trip succeeded and a `publicBaseUrl` was supplied.
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

  const client = createClient(candidate);

  // Auth + reachability probe. Its `list()` result also seeds the
  // empty-bucket guard below, so attaching a bucket costs one list call.
  let existingItems: { key: string }[];
  try {
    const listed = await client.list({ limit: 1000 });
    existingItems = listed.items;
  } catch (err) {
    checks.push({ id: "auth", ok: false, required: true, hint: hintForAuthError(err) });
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
  try {
    await client.upload(probeKey, probeBytes, { contentType: "application/octet-stream" });
    const downloaded = await client.download(probeKey);
    const readBack = new Uint8Array(await downloaded.arrayBuffer());
    roundTripOk = bytesEqual(probeBytes, readBack);
    if (!roundTripOk) {
      roundTripHint =
        "wrote and read back a probe object but the bytes didn't match — check for another writer racing this bucket";
    } else if (candidate.publicBaseUrl) {
      publicUrlCheck = await checkPublicUrl(
        candidate.publicBaseUrl,
        probeKey,
        probeBytes,
        fetchImpl,
      );
    }
  } catch (err) {
    roundTripHint =
      errorCode(err) === "Unauthorized"
        ? "the access key can read this bucket but was rejected on write — the R2 API token needs Object Read & Write, not read-only"
        : "could not write/read/delete a test object in this bucket — check the token's permissions";
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
      : "this bucket already has objects in it — pass adoptExistingContents to attach it anyway, or point at an empty bucket",
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
  }

  return { ok: checks.filter((c) => c.required).every((c) => c.ok), checks };
}
