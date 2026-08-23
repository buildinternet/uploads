/**
 * S3 `ListBuckets` against a Cloudflare R2 account (issue #783 Part A item
 * 2: the wizard's bucket picker). files-sdk's R2 adapter is bucket-scoped —
 * there's no `listBuckets` primitive to reuse — and `ListBuckets` is
 * account-level, so this calls it directly.
 *
 * Deliberately NOT `@aws-sdk/client-s3`: its XML response parser reaches for
 * `DOMParser`, which workerd doesn't provide (the same reason
 * `packages/storage` pins `client: "fetch"` for HTTP-mode R2 — see its
 * comment). `aws4fetch`'s `AwsClient` only signs the request; the response
 * body is parsed here with a small string/regex scan instead of a DOM API.
 *
 * Also resolves jurisdiction the same way `storage-verify.ts` does when the
 * caller doesn't already know it (a bare account id, no endpoint URL to
 * parse): probe the default endpoint, then `eu`, then `fedramp`, and use
 * whichever one actually answers.
 */
import { AwsClient } from "aws4fetch";
import { isR2Jurisdiction, R2_JURISDICTIONS, type R2Jurisdiction } from "@uploads/storage";

export interface ListBucketsCredentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Skips auto-probing when already known (e.g. parsed from a pasted endpoint URL). */
  jurisdiction?: string;
}

export type ListBucketsResult =
  | { ok: true; buckets: string[]; jurisdiction?: R2Jurisdiction }
  /**
   * `access_denied` is the expected shape for a bucket-scoped token — R2
   * only permits `ListBuckets` for account-scoped tokens — so the wizard
   * treats it as a normal fallback trigger, not an error state.
   */
  | { ok: false; reason: "access_denied" }
  | { ok: false; reason: "error"; message: string };

const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;

function r2Endpoint(accountId: string, jurisdiction: R2Jurisdiction | undefined): string {
  return jurisdiction
    ? `https://${accountId}.${jurisdiction}.r2.cloudflarestorage.com/`
    : `https://${accountId}.r2.cloudflarestorage.com/`;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Extracts `<Name>` values from `<Bucket>` entries in an S3 `ListBuckets`
 * XML body — a small string scan rather than an XML parser (no `DOMParser`
 * in workerd; see module doc). Exported so tests can exercise it directly
 * against real-shaped R2 response bodies without a network fake.
 */
export function parseListBucketsXml(xml: string): string[] {
  const names: string[] = [];
  const bucketRe = /<Bucket>([\s\S]*?)<\/Bucket>/g;
  let bucketMatch: RegExpExecArray | null;
  while ((bucketMatch = bucketRe.exec(xml))) {
    const nameMatch = /<Name>([^<]*)<\/Name>/.exec(bucketMatch[1]);
    if (nameMatch) names.push(decodeXmlEntities(nameMatch[1]));
  }
  return names;
}

/** One S3 `GET /` (ListBuckets) attempt against a specific jurisdiction's endpoint. */
async function attemptListBuckets(
  creds: ListBucketsCredentials,
  jurisdiction: R2Jurisdiction | undefined,
  fetchImpl: typeof fetch,
): Promise<{ status: number; body: string }> {
  const client = new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const signed = await client.sign(r2Endpoint(creds.accountId, jurisdiction), { method: "GET" });
  const res = await fetchImpl(signed);
  return { status: res.status, body: await res.text() };
}

export interface ListR2BucketsOptions {
  /** Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}

/**
 * Runs `ListBuckets`, auto-probing jurisdiction the same order
 * `verifyStorageConfig` uses when `creds.jurisdiction` isn't already known.
 * A 403 (Access Denied — the expected outcome for a bucket-scoped token) is
 * reported distinctly from any other failure so the wizard can fall back to
 * a plain "Bucket Name" field without treating it as an error.
 */
export async function listR2Buckets(
  creds: ListBucketsCredentials,
  opts: ListR2BucketsOptions = {},
): Promise<ListBucketsResult> {
  if (!ACCOUNT_ID_RE.test(creds.accountId)) {
    return {
      ok: false,
      reason: "error",
      message: "accountId must be a 32-character hex Cloudflare account id",
    };
  }
  if (creds.jurisdiction !== undefined && !isR2Jurisdiction(creds.jurisdiction)) {
    return {
      ok: false,
      reason: "error",
      message: `jurisdiction must be one of: ${R2_JURISDICTIONS.join(", ")} (or omitted)`,
    };
  }
  if (!creds.accessKeyId || !creds.secretAccessKey) {
    return {
      ok: false,
      reason: "error",
      message: "access key id and secret access key are both required",
    };
  }

  const fetchImpl = opts.fetch ?? fetch;
  const jurisdictionOrder: (R2Jurisdiction | undefined)[] =
    creds.jurisdiction !== undefined ? [creds.jurisdiction] : [undefined, ...R2_JURISDICTIONS];

  let sawAccessDenied = false;
  let lastError: string | undefined;
  for (const jurisdiction of jurisdictionOrder) {
    let attempt: { status: number; body: string };
    try {
      attempt = await attemptListBuckets(creds, jurisdiction, fetchImpl);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (attempt.status === 200) {
      return { ok: true, buckets: parseListBucketsXml(attempt.body), jurisdiction };
    }
    if (attempt.status === 403) {
      sawAccessDenied = true;
      continue;
    }
    lastError = `unexpected HTTP ${attempt.status} from ListBuckets`;
  }

  if (sawAccessDenied) return { ok: false, reason: "access_denied" };
  return { ok: false, reason: "error", message: lastError ?? "could not list buckets" };
}
