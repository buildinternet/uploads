/**
 * `uploads telemetry` — status / enable / disable for anonymous usage pings.
 */
import { flagBool, parseCommandArgs } from "../cli-args.js";
import { writeCommandHelp } from "../cli-style.js";
import { writeJson } from "../io.js";
import { setTelemetryEnabled, telemetryStatus, defaultTelemetryDataDir } from "../telemetry.js";

const TELEMETRY_HELP = `uploads telemetry — manage anonymous usage telemetry

Subcommands:
  status     Show whether telemetry is enabled and where events go
  enable     Enable anonymous usage telemetry
  disable    Disable anonymous usage telemetry

What is collected (when enabled):
  command name, CLI version, OS/arch, runtime, exit code, duration,
  client kind/agent, anonymous id, optional allowlisted error code.
  Never arguments, paths, tokens, workspace names, or file content.

Opt out without this command:
  UPLOADS_TELEMETRY_DISABLED=1
  DO_NOT_TRACK=1

Examples:
  uploads telemetry status
  uploads telemetry status --json
  uploads telemetry disable
  uploads telemetry enable
`;

export async function runTelemetry(
  args: string[],
  opts: { json?: boolean; apiUrl?: string } = {},
  help = false,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help || parsed.positionals.length === 0) {
    writeCommandHelp(TELEMETRY_HELP);
    return 0;
  }

  const sub = parsed.positionals[0];
  const json = opts.json || flagBool(parsed.flags, "--json");

  switch (sub) {
    case "status": {
      const s = telemetryStatus({ apiUrl: opts.apiUrl });
      if (json) {
        await writeJson({
          enabled: s.enabled,
          reason: s.reason ?? null,
          anonId: s.anonId,
          clientKind: s.clientKind,
          agentName: s.agentName ?? null,
          endpoint: s.endpoint,
          dataDir: defaultTelemetryDataDir(),
        });
        return 0;
      }
      process.stdout.write(`Telemetry: ${s.enabled ? "enabled" : "disabled"}\n`);
      if (!s.enabled && s.reason) process.stdout.write(`Reason:    ${s.reason}\n`);
      process.stdout.write(`Anon ID:   ${s.anonId}\n`);
      process.stdout.write(`Kind:      ${s.clientKind}${s.agentName ? ` (${s.agentName})` : ""}\n`);
      process.stdout.write(`Endpoint:  ${s.endpoint}\n`);
      process.stdout.write(
        "\nCollected: command name, version, OS/arch, runtime, exit code, duration,\n",
      );
      process.stdout.write(
        "           client kind, anonymous id, optional allowlisted error code.\n",
      );
      process.stdout.write("Never:     arguments, paths, tokens, workspace names, or content.\n");
      return 0;
    }
    case "enable": {
      setTelemetryEnabled(true);
      const s = telemetryStatus({ apiUrl: opts.apiUrl });
      if (json) {
        await writeJson({ enabled: s.enabled, reason: s.reason ?? null });
      } else if (s.enabled) {
        process.stdout.write("Telemetry enabled.\n");
      } else {
        process.stdout.write(`Telemetry still disabled (${s.reason ?? "opt-out active"}).\n`);
        process.stdout.write("Cleared the local disable file; env opt-outs still apply.\n");
      }
      return 0;
    }
    case "disable": {
      setTelemetryEnabled(false);
      if (json) await writeJson({ enabled: false });
      else process.stdout.write("Telemetry disabled.\n");
      return 0;
    }
    default:
      process.stderr.write(`error: unknown telemetry subcommand: ${sub}\n`);
      process.stderr.write("hint: uploads telemetry --help\n");
      return 2;
  }
}
