/**
 * The canonical upload metadata vocabulary: a small closed set of keys that
 * `uploads find` can rely on being spelled consistently. Most are derived (see
 * capture-facts.ts / image-facts.ts); only `state` and `app` are typed by hand.
 *
 * Design: .context/2026-07-21-upload-metadata-vocabulary-design.md
 */
import { UsageError } from "./cli-args.js";
import { validateMetaMap } from "./metadata.js";

export const CANONICAL_META_KEYS = [
  "url",
  "path",
  "env",
  "theme",
  "viewport",
  "device",
  "software",
  "captured",
  "state",
  "app",
] as const;

export type CanonicalMetaKey = (typeof CANONICAL_META_KEYS)[number];

const CANONICAL_KEY_SET: ReadonlySet<string> = new Set(CANONICAL_META_KEYS);

/** Closed enum for `state` — the highest-value hand-supplied search facet. */
export const META_STATE_VALUES = ["before", "after", "empty", "error", "loading"] as const;

export type MetaStateValue = (typeof META_STATE_VALUES)[number];

const STATE_VALUE_SET: ReadonlySet<string> = new Set(META_STATE_VALUES);

/** Common spellings agents reach for, mapped to the canonical `state` value. */
const STATE_ALIASES: Readonly<Record<string, MetaStateValue>> = {
  pre: "before",
  prior: "before",
  old: "before",
  previous: "before",
  post: "after",
  new: "after",
  updated: "after",
  blank: "empty",
  none: "empty",
  failure: "error",
  failed: "error",
  err: "error",
  spinner: "loading",
  pending: "loading",
  busy: "loading",
};

/**
 * Validate a `--state` value. Fails fast with a suggestion when the value is a
 * recognized near-miss, otherwise lists the valid set.
 */
export function validateStateValue(raw: string): MetaStateValue {
  const value = raw.trim().toLowerCase();
  if (STATE_VALUE_SET.has(value)) return value as MetaStateValue;
  const suggestion = STATE_ALIASES[value];
  if (suggestion) {
    throw new UsageError(`invalid --state: "${raw}" — did you mean "${suggestion}"?`);
  }
  throw new UsageError(
    `invalid --state: "${raw}" (expected one of: ${META_STATE_VALUES.join(", ")})`,
  );
}

/** Common misspellings of canonical keys, mapped to the canonical spelling. */
const META_KEY_ALIASES: Readonly<Record<string, CanonicalMetaKey>> = {
  route: "path",
  page: "path",
  screen: "path",
  pathname: "path",
  mode: "theme",
  appearance: "theme",
  colorscheme: "theme",
  environment: "env",
  stage: "env",
  surface: "app",
  platform: "app",
  status: "state",
  variant: "state",
  resolution: "viewport",
  size: "viewport",
  dimensions: "viewport",
  link: "url",
  href: "url",
  source: "url",
  model: "device",
  hardware: "device",
  when: "captured",
  date: "captured",
  timestamp: "captured",
};

/**
 * Warning lines for supplied keys that look like misspellings of canonical
 * ones. Callers warn and continue — we never silently rewrite a caller's key,
 * because a wrong guess is worse than a nag.
 */
export function nearMissMetaWarnings(keys: string[]): string[] {
  const warnings: string[] = [];
  for (const key of keys) {
    if (CANONICAL_KEY_SET.has(key)) continue;
    const canonical = META_KEY_ALIASES[key];
    if (canonical) {
      warnings.push(`metadata key "${key}" is not canonical — did you mean "${canonical}"?`);
    }
  }
  return warnings;
}

/** Canonical value format for the `viewport` key, e.g. `1280x800@2x`. */
export function formatViewport(width: number, height: number, scale: number): string {
  const trimmed = Number(scale.toFixed(2));
  return `${Math.round(width)}x${Math.round(height)}@${trimmed}x`;
}

/**
 * Merge derived pairs under the explicit ones, adding derived keys only while
 * the result still satisfies the metadata caps. Explicit keys always win and
 * are never dropped; a full key budget must never fail an upload.
 */
export function mergeDerivedMeta(
  explicit: Record<string, string>,
  derived: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...explicit };
  for (const [key, value] of Object.entries(derived)) {
    if (key in out) continue;
    const candidate = { ...out, [key]: value };
    try {
      validateMetaMap(candidate);
    } catch {
      continue; // derived key does not fit — drop it, keep going
    }
    out[key] = value;
  }
  return out;
}
