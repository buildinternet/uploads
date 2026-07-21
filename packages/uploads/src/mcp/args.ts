/**
 * Argument helpers shared by the stdio MCP tool set (./tools.ts) and the
 * remote worker's tool set (apps/mcp). Runtime-agnostic — usable from
 * Workers as well as Node.
 */
import { UploadsError } from "../errors.js";

export type ToolArgs = Record<string, unknown>;

export function usage(msg: string): never {
  throw new UploadsError(msg, "USAGE");
}

export function optString(args: ToolArgs, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") usage(`${name} must be a string`);
  return v;
}

/** A boolean flag argument; missing/null reads as `false`. */
export function optBool(args: ToolArgs, name: string): boolean {
  const v = args[name];
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") usage(`${name} must be a boolean`);
  return v;
}

export function optPosInt(args: ToolArgs, name: string): number | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    usage(`${name} must be a positive integer`);
  }
  return v;
}

/** A JSON-object argument of string→string pairs (e.g. a `metadata` or `filters` param). */
export function optStringRecord(args: ToolArgs, name: string): Record<string, string> | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) {
    usage(`${name} must be an object of string values`);
  }
  // Object.create(null): a plain `{}` would silently drop a `__proto__` key
  // (it hits the inherited setter instead of becoming an own property),
  // turning a malicious/malformed key into a no-op rather than a rejected
  // input. A null-prototype object makes every key a real own property so
  // downstream validation (e.g. META_KEY_RE) sees and rejects it.
  const result = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof value !== "string") usage(`${name}.${key} must be a string`);
    result[key] = value;
  }
  return result;
}

/** A JSON-array argument of strings (e.g. a `delete` or `files` param). */
export function optStringArray(args: ToolArgs, name: string): string[] | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((item) => typeof item !== "string")) {
    usage(`${name} must be an array of strings`);
  }
  return v as string[];
}

/**
 * Shared tool-description text for the metadata-shaped `metadata`/`set`/
 * `filters` params across the CLI/local MCP (put/attach/set_metadata/
 * find_files) and the remote MCP worker (set_metadata/find_files).
 */
export const METADATA_DESCRIPTION =
  "Queryable custom metadata (key→value), separate from provenance. Omit to leave any metadata already stored for this key untouched; pass an object (even {}) to fully replace it. Keys: lowercase, ^[a-z][a-z0-9._-]{0,63}$. Values: 1-512 printable ASCII characters. Caps: at most 24 keys, at most 8192 total key+value bytes. Suggested keys: app, url, page, device, resolution, commit, branch. `gh.*` is reserved by convention for GitHub PR/issue attachment context (repo/kind/number/ref).";

export const metadataProp = {
  type: "object",
  additionalProperties: { type: "string" },
  description: METADATA_DESCRIPTION,
};
