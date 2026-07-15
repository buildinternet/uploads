/**
 * `uploads report` — explicit opt-in diagnostic message (+ optional log).
 */
import { createInterface } from "node:readline/promises";
import { flagBool, flagString, parseCommandArgs, UsageError } from "../cli-args.js";
import { writeCommandHelp } from "../cli-style.js";
import { writeJson } from "../io.js";
import {
  attachmentFromText,
  buildReportPayload,
  loadReportAttachment,
  MAX_REPORT_ATTACHMENT_BYTES,
  MAX_REPORT_MESSAGE,
  parseReportType,
  reportFallbackHint,
  REPORT_TYPES,
  submitReport,
  validateReportMessage,
} from "../report.js";

const REPORT_HELP = `uploads report [message] — send a diagnostic report (explicit opt-in)

Nothing is sent unless you run this (or the MCP report tool).

Options:
  --file <path>         Attach a text log/trace (max 256 KiB)
  --type <t>            bug | error | idea | other (default: other)
  --contact <value>     Optional email/handle for follow-up
  --command <name>      Command that failed (e.g. put) — no args/paths
  --error-code <code>   Optional UploadsError code (e.g. KEY_POLICY)
  --dry-run             Print the payload without sending
  --json                JSON on stdout

Examples:
  uploads report "put fails with KEY_POLICY on custom prefixes"
  uploads report --type bug --file ./trace.log "crash during optimize"
  uploads doctor --json 2>&1 | uploads report "doctor failed"
`;

/**
 * Bound stdin read. Stops once maxBytes is exceeded (returns what was read
 * plus a flag so callers can reject oversized input).
 */
async function readStdinBounded(maxBytes: number): Promise<{ text: string; exceeded: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let exceeded = false;
  for await (const chunk of process.stdin) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.byteLength;
    if (total > maxBytes) {
      exceeded = true;
      const keep = maxBytes - (total - buf.byteLength);
      if (keep > 0) chunks.push(buf.subarray(0, keep));
      break; // stop reading; peer close drains the rest
    }
    chunks.push(buf);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), exceeded };
}

export async function runReport(
  args: string[],
  opts: { json?: boolean; apiUrl?: string } = {},
  help = false,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    writeCommandHelp(REPORT_HELP);
    return 0;
  }

  const typeFlag = flagString(parsed.flags, "--type");
  if (typeFlag && !parseReportType(typeFlag)) {
    throw new UsageError(`--type must be one of: ${REPORT_TYPES.join(", ")}`);
  }

  const type = parseReportType(typeFlag) ?? "other";
  const dryRun = flagBool(parsed.flags, "--dry-run");
  const json = opts.json || flagBool(parsed.flags, "--json");
  const filePath = flagString(parsed.flags, "--file");
  const positional = parsed.positionals.length > 0 ? parsed.positionals.join(" ") : undefined;
  const hasPositional = Boolean(positional?.trim());
  const stdinIsPipe = !process.stdin.isTTY;

  // Only consume stdin when we still need a message or a piped attachment.
  // Skip when --file already supplies the log and a positional message exists.
  const needStdinAsMessage = stdinIsPipe && !hasPositional;
  const needStdinAsAttachment = stdinIsPipe && hasPositional && !filePath;
  let piped = "";
  let pipedExceeded = false;
  if (needStdinAsMessage || needStdinAsAttachment) {
    const max = needStdinAsAttachment ? MAX_REPORT_ATTACHMENT_BYTES : MAX_REPORT_MESSAGE + 1; // +1 so we can detect "too long"
    const result = await readStdinBounded(max);
    piped = result.text;
    pipedExceeded = result.exceeded;
  }
  const pipedTrimmed = piped.trim();

  let raw: string | null = null;
  if (hasPositional) raw = positional!;
  else if (pipedTrimmed) raw = pipedTrimmed;
  else if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await rl.question("What's going wrong? (blank to cancel)\n> ");
      raw = answer.trim() || null;
    } finally {
      rl.close();
    }
  }

  if (raw === null) {
    if (json) await writeJson({ ok: false, cancelled: true });
    else process.stderr.write("Cancelled — no report sent.\n");
    return 0;
  }

  if (needStdinAsMessage && (pipedExceeded || raw.length > MAX_REPORT_MESSAGE)) {
    throw new UsageError(
      'piped input is too long for the message — use: `… | uploads report "summary"`',
    );
  }

  const validated = validateReportMessage(raw);
  if (!validated.ok) throw new UsageError(validated.error);

  let attachment;
  try {
    if (filePath) attachment = loadReportAttachment(filePath);
    else if (needStdinAsAttachment && pipedTrimmed) {
      if (pipedExceeded) {
        throw new Error(`attachment exceeds ${MAX_REPORT_ATTACHMENT_BYTES} bytes`);
      }
      attachment = attachmentFromText(piped, "stdin.log");
    }
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  const payload = buildReportPayload(validated.message, {
    type,
    contact: flagString(parsed.flags, "--contact")?.trim() || undefined,
    surface: "cli",
    command: flagString(parsed.flags, "--command"),
    errorCode: flagString(parsed.flags, "--error-code"),
    attachment,
  });

  if (dryRun) {
    const preview = {
      ...payload,
      attachment: payload.attachment
        ? {
            filename: payload.attachment.filename,
            contentType: payload.attachment.contentType,
            bytes: new TextEncoder().encode(payload.attachment.body).byteLength,
            body: "[omitted in dry-run]",
          }
        : undefined,
    };
    if (json) await writeJson({ dryRun: true, payload: preview });
    else process.stdout.write(`[dry-run] would POST:\n${JSON.stringify(preview, null, 2)}\n`);
    return 0;
  }

  const result = await submitReport(payload, { apiUrl: opts.apiUrl });
  if (result.ok) {
    if (json) {
      await writeJson({ ok: true, id: result.id, hasAttachment: result.hasAttachment });
    } else {
      process.stdout.write(
        `Thanks — report received (id: ${result.id}${result.hasAttachment ? ", with attachment" : ""})\n`,
      );
    }
    return 0;
  }

  if (json) await writeJson({ ok: false, error: result.error });
  else {
    process.stderr.write(`error: couldn't send report: ${result.error}\n`);
    process.stderr.write(`hint: ${reportFallbackHint()}\n`);
  }
  return 1;
}
