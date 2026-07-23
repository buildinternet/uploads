import {
  flagBool,
  flagString,
  parseCommandArgs,
  UsageError,
  type GlobalFlags,
} from "../cli-args.js";
import { resolveConfig } from "../config.js";
import { execRunner, type CommandRunner } from "../github-gh.js";
import { writeCommandHelp } from "../cli-style.js";

export const DEFAULT_MCP_URL = "https://agents.uploads.sh/mcp";
const SKILL_SOURCE = "buildinternet/uploads";
const SKILL_NAMES = ["uploads-cli", "github-screenshots"];

const INSTALL_HELP = `uploads install — set up agent integrations (skills + remote MCP)

Installs the github-screenshots and uploads-cli agent skills and registers
the hosted MCP server with Claude Code. The remote MCP endpoint infers your
workspace from the bearer token, so only the token is needed.

Usage:
  uploads install [skill|mcp|all]     (default: all)

What it does:
  skill   Agent skills (via npx skills) — github-screenshots: visuals into
          PRs/issues; uploads-cli: full CLI reference
  mcp     Hosted MCP server in Claude Code — put, list, attach, galleries

What runs under the hood:
  skill   npx -y skills add ${SKILL_SOURCE} --skill <name> -g -y -a '*'
          (once per skill: ${SKILL_NAMES.join(", ")})
  mcp     claude mcp add --transport http uploads ${DEFAULT_MCP_URL} \\
            --header "Authorization: Bearer <token>"

Options:
  --url <endpoint>    Remote MCP endpoint (default: ${DEFAULT_MCP_URL})
  --name <name>       MCP server name in the client (default: uploads)
  --dry-run           Print the plan without running anything
  --verbose           Show underlying command output (default: errors only)

Examples:
  uploads install
  uploads install skill
  uploads install mcp
  uploads install --dry-run
`;

export interface StepResult {
  command: string[];
  ok: boolean;
  skipped?: "dry-run" | "sign-in";
  error?: string;
  output?: string;
}

/** Mask Bearer credentials and the configured token in any printed text. */
function redactor(token: string | undefined): (text: string) => string {
  return (text) => {
    let out = text.replace(/Bearer \S+/g, "Bearer ***");
    if (token) out = out.split(token).join("***");
    return out;
  };
}

export function runStep(run: CommandRunner, command: string[]): StepResult {
  try {
    const output = run(command[0], command.slice(1)).trim();
    return { command, ok: true, output: output || undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint =
      (err as NodeJS.ErrnoException).code === "ENOENT"
        ? `${command[0]} not found on PATH — install it, or run manually: ${command.join(" ")}`
        : message;
    return { command, ok: false, error: hint };
  }
}

function skillCommand(skill: string): string[] {
  // -g global, -y non-interactive, -a '*' every agent (skips the multi-select TUI)
  return ["npx", "-y", "skills", "add", SKILL_SOURCE, "--skill", skill, "-g", "-y", "-a", "*"];
}

function mcpCommand(name: string, url: string, bearer: string): string[] {
  return [
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
}

function peekToken(globals: GlobalFlags): string | undefined {
  try {
    const config = resolveConfig({
      apiUrl: globals.apiUrl,
      workspace: globals.workspace,
      token: globals.token,
      envFile: globals.envFile,
      requireToken: false,
    });
    return config.token || undefined;
  } catch {
    return undefined;
  }
}

function printHumanSteps(
  results: Record<string, StepResult>,
  redact: (s: string) => string,
  verbose: boolean,
): void {
  for (const [step, r] of Object.entries(results)) {
    const cmd = redact(r.command.join(" "));
    if (r.skipped === "dry-run") {
      process.stdout.write(`${step}: would run — ${cmd}\n`);
    } else if (r.skipped === "sign-in") {
      process.stdout.write(`${step}: skipped — ${redact(r.error ?? "needs sign-in")}\n`);
    } else if (r.ok) {
      process.stdout.write(`${step}: ok\n`);
      if (verbose && r.output) {
        process.stdout.write(`  ${redact(r.output).split("\n").join("\n  ")}\n`);
      }
    } else {
      process.stderr.write(`${step}: failed — ${redact(r.error ?? "")}\n`);
      if (verbose) process.stderr.write(`  command: ${cmd}\n`);
    }
  }
}

function printSuccessFooter(steps: string[], signedIn: boolean): void {
  process.stdout.write(
    `\nDone — ${steps.join(" and ")} ready.\n` +
      "Restart your agent session so it picks up the new skill/server.\n" +
      "Then ask it to host a screenshot or attach images to a PR — for example:\n" +
      '  "upload this screenshot and put it in the PR description"\n' +
      '  "attach before.png and after.png to this PR"\n',
  );
  if (!signedIn) {
    process.stdout.write(
      "\nNot signed in yet? Run `uploads login` once so put/attach/MCP can authenticate.\n",
    );
  }
}

export async function runInstall(
  args: string[],
  opts: { globals: GlobalFlags; json?: boolean; runner?: CommandRunner },
  help = false,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    writeCommandHelp(INSTALL_HELP);
    return 0;
  }

  const target = parsed.positionals[0] ?? "all";
  if (!["skill", "mcp", "all"].includes(target)) {
    throw new UsageError(`unknown install target: ${target} (expected skill, mcp, or all)`);
  }

  const url = flagString(parsed.flags, "--url") ?? DEFAULT_MCP_URL;
  const name = flagString(parsed.flags, "--name") ?? "uploads";
  const dryRun = flagBool(parsed.flags, "--dry-run");
  const verbose = flagBool(parsed.flags, "--verbose");
  const run = opts.runner ?? execRunner;
  const human = !opts.json && !dryRun;

  const token = peekToken(opts.globals);
  const signedIn = Boolean(token);
  const redact = redactor(token);
  const results: Record<string, StepResult> = {};

  if (target === "skill" || target === "all") {
    if (human) process.stdout.write("Installing skills…\n");
    for (const skill of SKILL_NAMES) {
      const command = skillCommand(skill);
      results[`skill:${skill}`] = dryRun
        ? { command, ok: true, skipped: "dry-run" }
        : runStep(run, command);
    }
  }

  if (target === "mcp" || target === "all") {
    if (!dryRun && !token) {
      results.mcp = {
        command: mcpCommand(name, url, "<token>"),
        ok: false,
        skipped: "sign-in",
        error: "needs sign-in — run `uploads login`, then `uploads install mcp`",
      };
    } else {
      const command = mcpCommand(name, url, token || "<token>");
      if (human) process.stdout.write("Installing MCP server…\n");
      results.mcp = dryRun ? { command, ok: true, skipped: "dry-run" } : runStep(run, command);
    }
  }

  const failed = Object.values(results).some((r) => !r.ok);

  if (opts.json) {
    const steps = Object.fromEntries(
      Object.entries(results).map(([key, r]) => [
        key,
        {
          command: r.command.map(redact),
          ok: r.ok,
          skipped: r.skipped,
          output: r.output === undefined ? undefined : redact(r.output),
          error: r.error === undefined ? undefined : redact(r.error),
        },
      ]),
    );
    process.stdout.write(JSON.stringify({ ok: !failed, steps }, null, 2) + "\n");
    return failed ? 1 : 0;
  }

  printHumanSteps(results, redact, verbose);

  const skillResults = Object.entries(results)
    .filter(([step]) => step.startsWith("skill:"))
    .map(([, r]) => r);
  const skillsOk = skillResults.length > 0 && skillResults.every((r) => r.ok);
  const skillsFailed = skillResults.some((r) => !r.ok);

  if (!failed && !dryRun) {
    const stepLabels = [
      ...new Set(Object.keys(results).map((k) => (k.startsWith("skill:") ? "skills" : k))),
    ];
    printSuccessFooter(stepLabels, signedIn);
  } else if (failed && !dryRun && skillsOk && results.mcp && !results.mcp.ok) {
    const next =
      results.mcp.skipped === "sign-in"
        ? "Sign in with `uploads login`, then re-run `uploads install mcp`."
        : "Fix the MCP step above, then re-run `uploads install mcp`.";
    process.stdout.write(`\nSkills are installed. ${next}\n`);
  } else if (failed && !dryRun && skillsFailed) {
    // Mixed or total skill failure used to print only per-step lines (#191).
    process.stdout.write(
      "\nSkill install incomplete. Fix the errors above, then re-run `uploads install skill`.\n",
    );
  }

  return failed ? 1 : 0;
}
