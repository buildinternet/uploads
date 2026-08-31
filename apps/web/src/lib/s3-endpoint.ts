/**
 * Parses the S3-compatible connect form's "Endpoint URL" field (issue
 * #825/BYO-S3 Task 5). Recognizes an AWS S3 endpoint in either its
 * path-style (`https://s3.<region>.amazonaws.com`) or virtual-hosted-style
 * (`https://<bucket>.s3.<region>.amazonaws.com`) shape and pulls the region
 * (and bucket, for the virtual-hosted form) out of it so the form can
 * auto-fill those fields. Any other https host is accepted as a plain
 * S3-compatible endpoint (MinIO, Backblaze, etc.) with no region/bucket
 * inference — the user fills those in themselves.
 */

export interface ParsedS3Endpoint {
  endpoint: string;
  region?: string;
  bucket?: string;
}

// `s3.<region>.amazonaws.com`, optionally preceded by `<bucket>.` (virtual-hosted style).
const AWS_HOST_RE = /^(?:([a-z0-9][a-z0-9.-]*)\.)?s3\.([a-z0-9-]+)\.amazonaws\.com$/i;

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
  if (url.pathname !== "/" && url.pathname !== "") return null;

  const host = url.hostname.toLowerCase();
  const match = AWS_HOST_RE.exec(host);
  if (match) {
    const [, bucket, region] = match;
    return {
      endpoint: `https://s3.${region}.amazonaws.com`,
      region,
      bucket: bucket ? bucket.toLowerCase() : undefined,
    };
  }

  return { endpoint: `https://${host}`, region: undefined, bucket: undefined };
}
