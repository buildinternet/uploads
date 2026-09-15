import { flagInt, flagString, parseCommandArgs, UsageError } from "../cli-args.js";
import { writeCommandHelp } from "../cli-style.js";
import { parseGithubIssueRef } from "../github.js";
import { resolveRepo } from "../github-gh.js";
import { writeJson, writeStdout } from "../io.js";
import type { CliContext } from "../commands.js";
import type { CreateFeedOptions } from "../client.js";

const FEED_HELP = `uploads feed <command> [args]

A public newest-first feed of screenshots tagged with a GitHub owner/repo,
or one pull request / issue. Same product — pass --pr, --issue, or --github
to scope it. A gallery is a hand-picked list; a feed is live. Anyone who
knows the URL can view it. Creating the same scope again returns the
existing feed.

Commands:
  create [--repo <owner/repo>] [--pr <n> | --issue <n> | --github <ref>] [--path <page-path>]
  show <feed-id>
  list [--limit <n>] [--cursor <c>]
  delete <feed-id>

Examples:
  uploads feed create
  uploads feed create --repo acme/app
  uploads feed create --repo acme/app --pr 123
  uploads feed create --github acme/app#123
  uploads feed create --repo acme/app --path /settings
  uploads feed show feed_example
`;

function resolveCreateOptions(parsed: ReturnType<typeof parseCommandArgs>): CreateFeedOptions {
  const github = flagString(parsed.flags, "--github");
  const pr = flagInt(parsed.flags, "--pr", "--pr");
  const issue = flagInt(parsed.flags, "--issue", "--issue");
  const path = flagString(parsed.flags, "--path");
  const repoFlag = flagString(parsed.flags, "--repo");

  if (pr != null && issue != null) {
    throw new UsageError("--pr and --issue are mutually exclusive", {
      example: "uploads feed create --repo owner/repo --pr 123",
    });
  }
  if (github && (pr != null || issue != null)) {
    throw new UsageError("--github cannot be combined with --pr or --issue", {
      example: "uploads feed create --github owner/repo#123",
    });
  }

  if (github) {
    const ref = parseGithubIssueRef(github);
    if (!ref) {
      throw new UsageError("--github must be owner/repo#number or a GitHub issue/PR URL", {
        example: "uploads feed create --github owner/repo#123",
      });
    }
    if (repoFlag && repoFlag.trim().toLowerCase() !== ref.repo) {
      throw new UsageError("--repo does not match --github", {
        example: "uploads feed create --github owner/repo#123",
      });
    }
    return {
      repo: ref.repo,
      path,
      number: ref.number,
      kind: ref.kind,
    };
  }

  return {
    repo: resolveRepo(repoFlag).toLowerCase(),
    path,
    ...(pr != null ? { number: pr, kind: "pull" as const } : {}),
    ...(issue != null ? { number: issue, kind: "issue" as const } : {}),
  };
}

export async function runFeed(ctx: CliContext, args: string[], help = false): Promise<number> {
  const parsed = parseCommandArgs(args);
  const action = parsed.positionals[0];
  if (help || parsed.help) {
    writeCommandHelp(FEED_HELP);
    return 0;
  }
  if (!action) {
    throw new UsageError("feed requires a subcommand: create, show, list, or delete", {
      example: "uploads feed create --repo owner/repo --pr 123",
    });
  }

  switch (action) {
    case "create": {
      const feed = await ctx.client.createFeed(resolveCreateOptions(parsed));
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
        { example: "uploads feed create --repo owner/repo --pr 123" },
      );
  }
}
