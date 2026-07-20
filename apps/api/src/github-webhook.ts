/**
 * GitHub App webhook verification + cache invalidation (spec
 * .context/284-github-webhooks-design.md). Every delivery is HMAC-verified,
 * then dispatched to a set of targeted KV deletes against GITHUB_CACHE — no
 * key-prefix scans. All handlers tolerate missing fields: a partial payload
 * means "nothing to invalidate here", never a throw. Entries self-heal via
 * their phase-1 TTLs, so a dropped delete only reverts to TTL latency.
 */

const enc = new TextEncoder();

/** Lowercase hex HMAC-SHA256 of `body` under `secret`, matching GitHub's digest. */
async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  let hex = "";
  for (const b of new Uint8Array(sig)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// Constant-time compare is hand-rolled over the hex strings rather than via the
// Workers-native `crypto.subtle.timingSafeEqual` (as admin.ts/workspace.ts do):
// that API is a Workers-only extension absent from this repo's plain-Node vitest
// runtime, so reusing it would make this security-sensitive path untestable.
/** Constant-time compare of two hex strings (length check + XOR accumulate). */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * True iff `signatureHeader` (`X-Hub-Signature-256`, `sha256=<hex>`) is a valid
 * HMAC of the exact raw body under `secret`. Callers MUST verify before parsing
 * JSON — the signature is over the bytes GitHub sent.
 */
export async function verifySignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const provided = signatureHeader.slice("sha256=".length);
  const expected = await hmacSha256Hex(secret, rawBody);
  return timingSafeEqualHex(provided, expected);
}

/** Lowercased `full_name` strings from a repositories-array field; [] if absent/malformed. */
function repoFullNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const name = (entry as { full_name?: unknown } | null)?.full_name;
    if (typeof name === "string") out.push(name.toLowerCase());
  }
  return out;
}

/**
 * Invalidate the phase-1 cache entries implied by one webhook delivery.
 * `ping` and unknown events are no-ops. Never throws on partial payloads.
 */
export async function handleWebhook(env: Env, eventType: string, payload: unknown): Promise<void> {
  const p = (payload ?? {}) as Record<string, unknown>;
  const keys: string[] = [];

  if (eventType === "installation") {
    const id = (p.installation as { id?: unknown } | undefined)?.id;
    if (typeof id === "number") keys.push(`ghtok:${id}`);
    for (const repo of repoFullNames(p.repositories)) keys.push(`ghinst:${repo}`);
  } else if (eventType === "installation_repositories") {
    for (const repo of repoFullNames(p.repositories_added)) keys.push(`ghinst:${repo}`);
    for (const repo of repoFullNames(p.repositories_removed)) keys.push(`ghinst:${repo}`);
  } else if (eventType === "issues" || eventType === "pull_request") {
    const fullName = (p.repository as { full_name?: unknown } | undefined)?.full_name;
    const item = (eventType === "issues" ? p.issue : p.pull_request) as
      | { number?: unknown }
      | undefined;
    if (typeof fullName === "string" && typeof item?.number === "number") {
      keys.push(`ghref:${fullName.toLowerCase()}#${item.number}`);
    }
  }
  // ping and unknown events fall through with no keys.

  // Use allSettled, not all: a rejecting delete must never propagate out of
  // handleWebhook and become a 500 on the webhook route. A failed delete is
  // harmless — the entry self-heals on its phase-1 TTL — so a webhook outage
  // must never break anything.
  await Promise.allSettled(keys.map((key) => env.GITHUB_CACHE.delete(key)));
}
