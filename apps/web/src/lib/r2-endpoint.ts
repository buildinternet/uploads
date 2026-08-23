/**
 * Parses the wizard's single "Account ID or S3 endpoint URL" field (issue
 * #783 Part A item 1). Cloudflare's R2 API token screen hands the user an
 * endpoint URL — `https://<accountId>[.<jurisdiction>].r2.cloudflarestorage.com`
 * — that encodes both the account id and the jurisdiction; a bare account id
 * is also accepted for anyone who already knows theirs. Parsed client-side
 * so the wizard never shows a separate jurisdiction field — the API contract
 * still receives plain `accountId`/`jurisdiction`, unaware anything was
 * merged on the client (`storage-verify.ts`'s shape check is unchanged).
 */

export interface ParsedAccountIdOrEndpoint {
  accountId: string;
  /** Present only when the pasted endpoint named one — a bare account id never implies a jurisdiction. */
  jurisdiction?: string;
}

const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;
const ENDPOINT_RE = /^https:\/\/([0-9a-f]{32})(?:\.([a-z0-9]+))?\.r2\.cloudflarestorage\.com\/?$/i;

/**
 * `null` when the input is neither a 32-hex account id nor a recognizable R2
 * endpoint URL — the caller should treat that as a validation error rather
 * than guessing.
 */
export function parseAccountIdOrEndpoint(input: string): ParsedAccountIdOrEndpoint | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (ACCOUNT_ID_RE.test(trimmed)) {
    return { accountId: trimmed.toLowerCase() };
  }
  const match = ENDPOINT_RE.exec(trimmed);
  if (!match) return null;
  const [, accountId, jurisdiction] = match;
  return {
    accountId: accountId.toLowerCase(),
    jurisdiction: jurisdiction ? jurisdiction.toLowerCase() : undefined,
  };
}
