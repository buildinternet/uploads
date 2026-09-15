import { flagInt, flagString, parseCommandArgs, UsageError } from "../cli-args.js";
import { writeCommandHelp } from "../cli-style.js";
import { resolveRepo } from "../github-gh.js";
import { writeJson, writeStdout } from "../io.js";
import type { CliContext } from "../commands.js";

const FEED_HELP = `uploads feed <command> [args]

A public newest-first feed of screenshots tagged with a GitHub owner/repo.
Anyone who knows the URL can view it. Creating the same repo (and optional
path) again returns the existing feed.

Commands:
  create [--repo <owner/repo>] [--path <page-path>]
  show <feed-id>
  list [--limit <n>] [--cursor <c>]
  delete <feed-id>

Examples:
  uploads feed create
  uploads feed create --repo acme/app
  uploads feed create --repo acme/app --path /settings
  uploads feed show feed_example
`;

export async function runFeed(ctx: CliContext, args: string[], help = false): Promise<number> {
  const parsed = parseCommandArgs(args);
  const action = parsed.positionals[0];
  if (help || parsed.help) {
    writeCommandHelp(FEED_HELP);
    return 0;
  }
  if (!action) {
    throw new UsageError("feed requires a subcommand: create, show, list, or delete", {
      example: "uploads feed create --repo owner/repo",
    });
  }

  switch (action) {
    case "create": {
      const repo = resolveRepo(flagString(parsed.flags, "--repo")).toLowerCase();
      const path = flagString(parsed.flags, "--path");
      const feed = await ctx.client.createFeed({ repo, path });
      if (ctx.json) await writeJson(feed);
      else await writeStdout(`${feed.url}\n`);
      if (!ctx.quiet && !ctx.json)
        process.stderr.write("warning: feeds are public to anyone with the URL\n");
      return 0;
    }
    case "show": {
      const id = parsed.positionals[1];
      if (!id) throw new UsageError("feed show requires a feed ID");
      const feed = await ctx.client.getFeed(id);
      if (ctx.json) await writeJson(feed);
      else await writeStdout(`${feed.url}\n`);
      return 0;
    }
    case "list": {
      const page = await ctx.client.listFeeds({
        limit: flagInt(parsed.flags, "--limit", "--limit"),
        cursor: flagString(parsed.flags, "--cursor"),
      });
      if (ctx.json) await writeJson(page);
      else {
        for (const feed of page.feeds)
          await writeStdout(`${feed.id}  ${feed.url}  ${feed.title}\n`);
        if (page.nextCursor) process.stderr.write(`cursor: ${page.nextCursor}\n`);
      }
      return 0;
    }
    case "delete": {
      const id = parsed.positionals[1];
      if (!id) throw new UsageError("feed delete requires a feed ID");
      const result = await ctx.client.deleteFeed(id);
      if (ctx.json) await writeJson(result);
      else if (!ctx.quiet) process.stderr.write(`deleted feed ${result.id}\n`);
      return 0;
    }
    default:
      throw new UsageError(
        `unknown feed command: ${action} (expected create, show, list, or delete)`,
        { example: "uploads feed create --repo owner/repo" },
      );
  }
}
