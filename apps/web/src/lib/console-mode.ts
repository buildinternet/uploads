/**
 * Resolves the /console visibility mode: Flagship flag first, CONSOLE_MODE
 * env var as the fallback, "linked-only" as the final default.
 *
 * This is a visibility knob, not a security boundary — the console is
 * bearer-token authenticated, so anyone with a valid workspace token can use
 * it regardless of this setting.
 *
 * Resolution order:
 * 1. `console-mode` flag on the FLAGS Flagship binding (app "uploads"),
 *    when the binding exists. The env-var fallback is passed in as the
 *    flag's default value, so a disabled flag or Flagship outage degrades
 *    to the env var rather than to a hardcoded value.
 * 2. `CONSOLE_MODE` env var (wrangler.jsonc vars) — also what self-hosters
 *    without Flagship use; they can delete the flagship binding entirely.
 * 3. "linked-only": the route serves, but nothing links to it.
 */

export type ConsoleMode = "public" | "linked-only" | "off";

const MODES: readonly ConsoleMode[] = ["public", "linked-only", "off"];

function asMode(value: unknown, fallback: ConsoleMode): ConsoleMode {
  return MODES.includes(value as ConsoleMode) ? (value as ConsoleMode) : fallback;
}

/** Minimal structural slice of the Flagship binding so this module doesn't
 * depend on generated worker types (worker-configuration.d.ts is gitignored
 * and absent until `wrangler types` runs). */
interface FlagshipLike {
  getStringValue(flagKey: string, defaultValue: string): Promise<string>;
}

export async function resolveConsoleMode(env: {
  CONSOLE_MODE?: string;
  FLAGS?: FlagshipLike;
}): Promise<ConsoleMode> {
  const fallback = asMode(env.CONSOLE_MODE, "linked-only");
  if (!env.FLAGS) return fallback;
  try {
    // The binding contract is "never throws, returns defaultValue on error",
    // but guard anyway — a fallback here must never take the page down.
    return asMode(await env.FLAGS.getStringValue("console-mode", fallback), fallback);
  } catch {
    return fallback;
  }
}
