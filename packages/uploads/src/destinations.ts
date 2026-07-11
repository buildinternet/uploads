/**
 * Typed destination roots for put/attach. Matches the API allowlist defaults
 * (`f/`, `screenshots/`, `gh/`) — see apps/api `key-policy.ts`.
 */

export const BUILTIN_DESTINATIONS = {
  f: "f",
  screenshots: "screenshots",
  gh: "gh",
} as const;

export type BuiltinDestinationId = keyof typeof BUILTIN_DESTINATIONS;

export function isBuiltinDestination(id: string): id is BuiltinDestinationId {
  return Object.hasOwn(BUILTIN_DESTINATIONS, id);
}

/** Root segment for a known destination, or throws with a usage-friendly message. */
export function resolveDestinationRoot(id: string): string {
  if (!isBuiltinDestination(id)) {
    const known = Object.keys(BUILTIN_DESTINATIONS).join(", ");
    throw new Error(`unknown destination: ${id} (known: ${known})`);
  }
  return BUILTIN_DESTINATIONS[id];
}

/** True when `key` is under the destination root. */
export function keyMatchesDestination(key: string, destinationId: string): boolean {
  if (!isBuiltinDestination(destinationId)) return false;
  const root = BUILTIN_DESTINATIONS[destinationId];
  return key === root || key.startsWith(`${root}/`);
}

/**
 * Resolve CLI/MCP destination flags into a put `prefix`. Throws plain Errors
 * (callers wrap as UsageError / MCP usage errors).
 */
export function resolvePutPrefix(opts: {
  destination?: string;
  prefix?: string;
  key?: string;
  /** When true (PR/issue attach), destination must be `gh` or omitted. */
  ghAttachment?: boolean;
}): string | undefined {
  const { destination, prefix, key, ghAttachment } = opts;
  if (!destination) return prefix;

  const root = resolveDestinationRoot(destination);

  if (ghAttachment && destination !== "gh") {
    throw new Error("destination with pr/issue must be gh (or omit it)");
  }
  if (key && !keyMatchesDestination(key, destination)) {
    throw new Error(`key must start with destination root "${root}/"`);
  }
  if (prefix && prefix.replace(/\/+$/, "") !== root) {
    throw new Error(`prefix (${prefix}) conflicts with destination ${destination} (root ${root})`);
  }
  return root;
}
