import { flagBool, flagInt, parseCommandArgs, UsageError } from "../cli-args.js";
import {
  DEFAULT_CHANGELOG_LIMIT,
  MAX_CHANGELOG_LIMIT,
  fetchChangelog,
  formatChangelogHuman,
  type FetchChangelogOptions,
} from "../changelog.js";
import { writeCommandHelp } from "../cli-style.js";
import { writeJson, writeStdout } from "../io.js";

const CHANGELOG_HELP = `uploads changelog — recent product updates

Prints the latest updates from uploads.sh, then a link to the full changelog.

Usage:
  uploads changelog [options]

Options:
  --limit <n>   Number of entries to show (default: ${DEFAULT_CHANGELOG_LIMIT}, max: ${MAX_CHANGELOG_LIMIT})
  --json        JSON on stdout (also accepts global --json)

Examples:
  uploads changelog
  uploads changelog --limit 10
  uploads changelog --json
`;

export interface RunChangelogOptions {
  json?: boolean;
  fetch?: FetchChangelogOptions["fetchImpl"];
  url?: string;
}

export async function runChangelog(
  args: string[],
  opts: RunChangelogOptions = {},
  help = false,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    writeCommandHelp(CHANGELOG_HELP);
    return 0;
  }
  if (parsed.positionals.length > 0) {
    throw new UsageError(`changelog takes no arguments (got ${parsed.positionals[0]})`, {
      example: "uploads changelog",
    });
  }

  const json = Boolean(opts.json) || flagBool(parsed.flags, "--json");
  const limit = flagInt(parsed.flags, "--limit", "--limit") ?? DEFAULT_CHANGELOG_LIMIT;
  if (limit > MAX_CHANGELOG_LIMIT) {
    throw new UsageError(`--limit must be ${MAX_CHANGELOG_LIMIT} or less (got ${limit})`, {
      example: `uploads changelog --limit ${MAX_CHANGELOG_LIMIT}`,
    });
  }

  const doc = await fetchChangelog({
    limit,
    fetchImpl: opts.fetch,
    url: opts.url,
  });

  if (json) await writeJson(doc);
  else await writeStdout(formatChangelogHuman(doc));
  return 0;
}
