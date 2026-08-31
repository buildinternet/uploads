/**
 * Parses the S3-compatible connect form's "Endpoint URL" field (issue
 * #825/BYO-S3 Task 5, extended for #904). Recognizes an AWS S3 endpoint in
 * any of these shapes and pulls the region (and bucket, where the shape
 * names one) out of it so the form can auto-fill those fields:
 *   - regional path-style: `https://s3.<region>.amazonaws.com`
 *   - regional virtual-hosted-style: `https://<bucket>.s3.<region>.amazonaws.com`
 *   - regional path-style with the bucket in the URL path:
 *     `https://s3.<region>.amazonaws.com/<bucket>`
 *   - legacy (no region in the host, implies us-east-1): `s3.amazonaws.com`
 *   - legacy virtual-hosted-style: `https://<bucket>.s3.amazonaws.com`
 * Any other https host is accepted as a plain S3-compatible endpoint
 * (MinIO, Backblaze, etc.) with no region inference; a single path segment
 * on such a host is treated as the bucket (path-style is the norm there),
 * and deeper paths are rejected as unrecognizable.
 */

export interface ParsedS3Endpoint {
  endpoint: string;
  region?: string;
  bucket?: string;
  /**
   * True when the bucket came from the URL *path* of a non-AWS host — the
   * paste itself demonstrates the deployment uses path-style addressing, so
   * the form should turn `forcePathStyle` on. AWS shapes never set this:
   * AWS accepts virtual-hosted requests against the canonical endpoint.
   */
  pathStyle?: boolean;
}

// `s3.<region>.amazonaws.com`, optionally preceded by `<bucket>.` (virtual-hosted style).
const AWS_HOST_RE = /^(?:([a-z0-9][a-z0-9.-]*)\.)?s3\.([a-z0-9-]+)\.amazonaws\.com$/i;

// Legacy host with no region: `s3.amazonaws.com`, optionally preceded by
// `<bucket>.` (legacy virtual-hosted style). Implies us-east-1.
const AWS_LEGACY_HOST_RE = /^(?:([a-z0-9][a-z0-9.-]*)\.)?s3\.amazonaws\.com$/i;

const LEGACY_REGION = "us-east-1";

/** A single path segment naming a bucket, e.g. `/my-bucket` or `/my-bucket/`. */
function pathBucket(pathname: string): string | undefined {
  const trimmed = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed || trimmed.includes("/")) return undefined;
  return trimmed;
}

/**
 * `null` when the input isn't a recognizable https URL (or bare host) at
 * all — the caller should treat that as a validation error rather than
 * guessing.
 */
export function parseS3Endpoint(input: string): ParsedS3Endpoint | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // A bare host (no scheme) is assumed https, same convention as the R2
  // account-id/endpoint field's tolerance for a pasted value missing its scheme.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase();

  const match = AWS_HOST_RE.exec(host);
  if (match) {
    const [, hostBucket, region] = match;
    // A virtual-hosted host (`<bucket>.s3.<region>.amazonaws.com`) already
    // names its bucket — a path alongside it isn't a recognized shape.
    if (hostBucket && url.pathname !== "/" && url.pathname !== "") return null;
    return {
      endpoint: `https://s3.${region}.amazonaws.com`,
      region,
      bucket: hostBucket ? hostBucket.toLowerCase() : pathBucket(url.pathname),
    };
  }

  const legacyMatch = AWS_LEGACY_HOST_RE.exec(host);
  if (legacyMatch) {
    const [, hostBucket] = legacyMatch;
    if (hostBucket && url.pathname !== "/" && url.pathname !== "") return null;
    return {
      endpoint: `https://s3.${LEGACY_REGION}.amazonaws.com`,
      region: LEGACY_REGION,
      bucket: hostBucket ? hostBucket.toLowerCase() : pathBucket(url.pathname),
    };
  }

  // Any other https host (MinIO, Backblaze, ...): path-style is the norm
  // for these, so a single path segment is treated as the bucket — the form
  // only fills empty fields, so a wrong inference is visible and editable.
  // A deeper path isn't a recognizable endpoint shape at all.
  if (url.pathname !== "/" && url.pathname !== "") {
    const bucket = pathBucket(url.pathname);
    if (!bucket) return null;
    return { endpoint: `https://${url.host}`, region: undefined, bucket, pathStyle: true };
  }
  return { endpoint: `https://${url.host}`, region: undefined, bucket: undefined };
}
