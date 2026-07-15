import { WS_NAME_RE } from "./workspace";
import { SLUG_BLOCKLIST, SLUG_BLOCKLIST_ALLOW } from "./slug-blocklist";

/** Names that collide with routes, subdomains, or communal tenants. */
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
  // Any allowlisted word neutralizes the exact span it covers; simplest sound
  // approximation: if the flat string equals or contains only allowlisted
  // words around the hit, skip. We keep it simple: a slug whose flat form
  // contains an allowlisted word that itself contains the blocklist hit is OK.
  for (const term of SLUG_BLOCKLIST) {
    const at = flat.indexOf(term);
    if (at === -1) continue;
    const excused = SLUG_BLOCKLIST_ALLOW.some(
      (allow) => allow.includes(term) && flat.includes(allow),
    );
    if (!excused) return true;
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
