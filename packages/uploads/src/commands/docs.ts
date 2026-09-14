import { flagBool, flagInt, flagString, parseCommandArgs, UsageError } from "../cli-args.js";
import { UploadsError } from "../errors.js";
import {
  DEFAULT_DOCS_LIMIT,
  MAX_DOCS_LIMIT,
  formatDocsHuman,
  searchDocs,
  type SearchDocsOptions,
} from "../docs.js";
import { writeCommandHelp } from "../cli-style.js";
import { writeJson, writeStdout } from "../io.js";

const DOCS_HELP = `uploads docs — search public uploads.sh documentation

Lists the docs catalog, searches by topic, or fetches one page as markdown.

Usage:
  uploads docs [query…] [options]

Options:
  --page <slug>  Fetch the full markdown of one page (slug, path, or URL)
  --limit <n>    Number of search hits to show (default ${DEFAULT_DOCS_LIMIT}, max ${MAX_DOCS_LIMIT})
  --json         JSON on stdout (also accepts global --json)

Examples:
  uploads docs
  uploads docs stage before a PR
  uploads docs attach
  uploads docs --page agents
  uploads docs --json "github app"
`;

export interface RunDocsOptions {
  json?: boolean;
  fetch?: SearchDocsOptions["fetchImpl"];
  url?: string;
  catalog?: SearchDocsOptions["catalog"];
}

export async function runDocs(
  args: string[],
  opts: RunDocsOptions = {},
  help = false,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    writeCommandHelp(DOCS_HELP);
    return 0;
  }

  const json = Boolean(opts.json) || flagBool(parsed.flags, "--json");
  const page = flagString(parsed.flags, "--page");
  const limit = flagInt(parsed.flags, "--limit", "--limit");
  if (limit !== undefined && limit > MAX_DOCS_LIMIT) {
    throw new UsageError(`--limit must be ${MAX_DOCS_LIMIT} or less (got ${limit})`, {
      example: `uploads docs --limit ${MAX_DOCS_LIMIT}`,
    });
  }
  const query = parsed.positionals.join(" ").trim();
  if (page && query) {
    throw new UsageError("pass a search query or --page, not both", {
      example: "uploads docs --page attach",
    });
  }

  let doc;
  try {
    doc = await searchDocs({
      query: query || undefined,
      page: page || undefined,
      limit,
      fetchImpl: opts.fetch,
      url: opts.url,
      catalog: opts.catalog,
    });
  } catch (err) {
    if (err instanceof UploadsError && err.code === "USAGE") {
      throw new UsageError(err.message, { example: "uploads docs --page attach" });
    }
    throw err;
  }

  if (json) await writeJson(doc);
  else await writeStdout(formatDocsHuman(doc));
  return 0;
}
