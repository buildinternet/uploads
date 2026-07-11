/**
 * Opt-in object-key policy for put/sign. When unset, any nested path is allowed
 * (internal/BYO). Shared agent workspaces typically set
 * `allowedKeyPrefixes: ["f","screenshots","gh"]` (or the operator sentinel
 * `default`) and `maxKeyDepth: 8`.
 */
import type { WorkspaceRecord } from "./workspace";

/** Built-in roots used by the CLI (`--destination`) and recommended allowlist. */
export const BUILTIN_DESTINATIONS = {
  f: "f",
  screenshots: "screenshots",
  gh: "gh",
} as const;

export type BuiltinDestinationId = keyof typeof BUILTIN_DESTINATIONS;

/** `default` operator sentinel expands to these roots (with trailing `/`). */
export const DEFAULT_ALLOWED_PREFIXES: readonly string[] = [
  `${BUILTIN_DESTINATIONS.f}/`,
  `${BUILTIN_DESTINATIONS.screenshots}/`,
  `${BUILTIN_DESTINATIONS.gh}/`,
];

export type KeyPolicy = {
  /** Normalized roots ending with `/`, or null when unrestricted. */
  allowedKeyPrefixes: string[] | null;
  /** Max `/`-separated segments, or null when unrestricted. */
  maxKeyDepth: number | null;
};

const ROOT_SEG_RE = /^[a-zA-Z0-9][\w.-]{0,62}$/;

/** Normalize a prefix entry to `root/` form, or null if invalid. */
export function normalizeKeyPrefix(raw: string): string | null {
  const trimmed = raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return null;
  const segs = trimmed.split("/");
  if (segs.some((s) => !s || s === "." || s === ".." || !ROOT_SEG_RE.test(s))) return null;
  return `${trimmed}/`;
}

/**
 * Parse allowed prefixes. Accepts `f`, `f/`, nested roots, and `default`
 * (→ f + screenshots + gh). Invalid entries are skipped.
 */
export function normalizeAllowedKeyPrefixes(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const item of list) {
    if (typeof item !== "string") continue;
    const raw = item.trim();
    if (!raw) continue;
    if (/^default$/i.test(raw)) {
      for (const p of DEFAULT_ALLOWED_PREFIXES) out.add(p);
      continue;
    }
    const normalized = normalizeKeyPrefix(raw);
    if (normalized) out.add(normalized);
  }
  return [...out].sort();
}

export function resolveKeyPolicy(
  record: Pick<WorkspaceRecord, "allowedKeyPrefixes" | "maxKeyDepth">,
): KeyPolicy {
  const prefixes = normalizeAllowedKeyPrefixes(record.allowedKeyPrefixes);
  const depth =
    typeof record.maxKeyDepth === "number" &&
    Number.isInteger(record.maxKeyDepth) &&
    record.maxKeyDepth >= 1
      ? Math.min(record.maxKeyDepth, 64)
      : null;
  return {
    allowedKeyPrefixes: prefixes.length > 0 ? prefixes : null,
    maxKeyDepth: depth,
  };
}

export type KeyPolicyViolation =
  | {
      code: "key_prefix_not_allowed";
      message: string;
      allowedKeyPrefixes: string[];
    }
  | {
      code: "key_too_deep";
      message: string;
      maxKeyDepth: number;
      depth: number;
    };

/** Structured violation when `key` fails the workspace policy, else null. */
export function checkKeyPolicy(key: string, policy: KeyPolicy): KeyPolicyViolation | null {
  if (policy.maxKeyDepth !== null) {
    const depth = key.split("/").length;
    if (depth > policy.maxKeyDepth) {
      return {
        code: "key_too_deep",
        message: `key exceeds max depth (${depth} > ${policy.maxKeyDepth} segments)`,
        maxKeyDepth: policy.maxKeyDepth,
        depth,
      };
    }
  }

  if (policy.allowedKeyPrefixes !== null) {
    const allowed = policy.allowedKeyPrefixes;
    if (!allowed.some((prefix) => key.startsWith(prefix))) {
      return {
        code: "key_prefix_not_allowed",
        message: `key prefix not allowed (must start with one of: ${allowed.join(", ")})`,
        allowedKeyPrefixes: allowed,
      };
    }
  }

  return null;
}
