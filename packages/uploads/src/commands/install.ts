import {
  flagBool,
  flagString,
  parseCommandArgs,
  UsageError,
  type GlobalFlags,
} from "../cli-args.js";
import { resolveConfig } from "../config.js";
import { execRunner, type CommandRunner } from "../github-gh.js";

export const DEFAULT_MCP_URL = "https://agents.uploads.sh/mcp";
const SKILL_SOURCE = "buildinternet/uploads";
const SKILL_NAME = "uploads-cli";

const INSTALL_HELP = `uploads install — set up agent integrations (skill + remote MCP)

Installs the uploads-cli agent skill and registers the hosted MCP server
with Claude Code. The remote MCP endpoint infers your workspace from the
bearer token, so only the token is needed.

Usage:
  uploads install [skill|mcp|all]     (default: all)

What runs:
  skill   npx -y skills add ${SKILL_SOURCE} --skill ${SKILL_NAME}
  mcp     claude mcp add --transport http uploads ${DEFAULT_MCP_URL} \\
            --header "Authorization: Bearer <token>"

Options:
  --url <endpoint>    Remote MCP endpoint (default: ${DEFAULT_MCP_URL})
  --name <name>       MCP server name in the client (default: uploads)
  --dry-run           Print the commands without running them

Examples:
  uploads install
  uploads install skill
  uploads install mcp --dry-run
`;

interface StepResult {
  command: string[];
  ok: boolean;
  skipped?: string;
  error?: string;
  output?: string;
}

function runStep(run: CommandRunner, command: string[]): StepResult {
  try {
    const output = run(command[0], command.slice(1)).trim();
    return { command, ok: true, output: output || undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // execFileSync's ENOENT means the binary itself is missing.
    const hint =
      (err as NodeJS.ErrnoException).code === "ENOENT"
        ? `${command[0]} not found on PATH — run manually: ${command.join(" ")}`
        : message;
    return { command, ok: false, error: hint };
  }
}

export async function runInstall(
  args: string[],
  opts: { globals: GlobalFlags; json?: boolean; runner?: CommandRunner },
  help = false,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    process.stderr.write(INSTALL_HELP);
    return 0;
  }

  const target = parsed.positionals[0] ?? "all";
  if (!["skill", "mcp", "all"].includes(target)) {
    throw new UsageError(`unknown install target: ${target} (expected skill, mcp, or all)`);
  }
  const url = flagString(parsed.flags, "--url") ?? DEFAULT_MCP_URL;
  const name = flagString(parsed.flags, "--name") ?? "uploads";
  const dryRun = flagBool(parsed.flags, "--dry-run");
  const run = opts.runner ?? execRunner;

  const results: Record<string, StepResult> = {};

  if (target === "skill" || target === "all") {
    const command = ["npx", "-y", "skills", "add", SKILL_SOURCE, "--skill", SKILL_NAME];
    results.skill = dryRun ? { command, ok: true, skipped: "dry-run" } : runStep(run, command);
  }

  if (target === "mcp" || target === "all") {
    const config = resolveConfig({
      apiUrl: opts.globals.apiUrl,
      workspace: opts.globals.workspace,
      token: opts.globals.token,
      envFile: opts.globals.envFile,
      requireToken: !dryRun,
    });
    const bearer = config.token || "<token>";
    const command = [
      "claude",
      "mcp",
      "add",
      "--transport",
      "http",
      name,
      url,
      "--header",
      `Authorization: Bearer ${bearer}`,
    ];
    results.mcp = dryRun ? { command, ok: true, skipped: "dry-run" } : runStep(run, command);
  }

  const failed = Object.values(results).some((r) => !r.ok);

  if (opts.json) {
    // Never echo the token in structured output.
    const redacted = Object.fromEntries(
      Object.entries(results).map(([key, r]) => [
        key,
        { ...r, command: r.command.map((part) => part.replace(/Bearer up_\S+/, "Bearer ***")) },
      ]),
    );
    process.stdout.write(JSON.stringify({ ok: !failed, steps: redacted }, null, 2) + "\n");
    return failed ? 1 : 0;
  }

  for (const [step, r] of Object.entries(results)) {
    const shown = r.command.map((part) => part.replace(/Bearer up_\S+/, "Bearer ***")).join(" ");
    if (r.skipped) process.stdout.write(`${step}: would run — ${shown}\n`);
    else if (r.ok) {
      process.stdout.write(`${step}: ok — ${shown}\n`);
      if (r.output) process.stdout.write(`  ${r.output.split("\n").join("\n  ")}\n`);
    } else process.stderr.write(`${step}: failed — ${r.error}\n`);
  }
  if (!failed && !dryRun) {
    process.stderr.write("hint: restart your agent session to pick up the new skill/server\n");
  }
  return failed ? 1 : 0;
}
