import { WS_NAME_RE } from "./workspace";
import { SLUG_BLOCKLIST, SLUG_BLOCKLIST_ALLOW } from "./slug-blocklist";

/** Names that collide with routes or subdomains. */
export const RESERVED_WORKSPACE_NAMES: ReadonlySet<string> = new Set([
  "default",
  "admin",
  "api",
  "www",
  "storage",
  "embed",
  "auth",
  "mcp",
  "f",
  "public",
  "account",
  "me",
  "invite",
  "uploads",
  "internal",
  "v1",
  "workspaces",
  "tokens",
  "files",
  "galleries",
  "usage",
  "health",
  "admin-ui",
  // Account UI route: /account/workspaces/new
  "new",
]);

export type SlugVerdict =
  | { ok: true }
  | { ok: false; code: "invalid_workspace_name" | "reserved_workspace_name" };

/**
 * Reduce a slug to bare letters so `s0me-slur` and `some-slur` normalize to
 * the same string before the substring scan. Digit→letter lookalikes are
 * folded (0→o, 1→i, 3→e, 4→a, 5→s, 7→t).
 */
function lettersOnly(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/[^a-z]/g, "");
}

function blocked(slug: string): boolean {
  const flat = lettersOnly(slug);
  // Per-occurrence allowlisting: remove every span covered by an allowlisted
  // word first, then scan what's left for blocklist terms. This prevents an
  // allowlisted word from excusing a *different*, standalone occurrence of a
  // blocklist term elsewhere in the slug (e.g. "grape-rape" must not let
  // "grape" excuse the separate "rape"). Removed spans are replaced with "#",
  // a character that can never appear in `flat` or in any blocklist/allow
  // term, so remaining fragments can't be stitched back together into a hit.
  let remainder = flat;
  for (const allow of SLUG_BLOCKLIST_ALLOW) {
    remainder = remainder.split(allow).join("#".repeat(allow.length));
  }
  for (const term of SLUG_BLOCKLIST) {
    if (remainder.includes(term)) return true;
  }
  return false;
}

/** Blocklist verdicts intentionally reuse invalid_workspace_name — never echo why. */
export function validateSlug(name: string): SlugVerdict {
  if (!WS_NAME_RE.test(name)) return { ok: false, code: "invalid_workspace_name" };
  if (RESERVED_WORKSPACE_NAMES.has(name)) return { ok: false, code: "reserved_workspace_name" };
  if (blocked(name)) return { ok: false, code: "invalid_workspace_name" };
  return { ok: true };
}
