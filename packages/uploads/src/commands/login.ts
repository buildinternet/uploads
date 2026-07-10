import { stdin, stdout } from "node:process";
import {
  loadConfigFile,
  redactToken,
  resolveConfigPath,
  writeConfigKeys,
  workspaceFromToken,
} from "../config.js";
import { exchangeEnrollment, createUploadsClient } from "../client.js";
import { flagBool, flagString, parseCommandArgs, UsageError } from "../cli-args.js";

const HELP = `uploads login [options]

Exchange a one-time enrollment code for workspace credentials, save them, and
verify access. Ask your uploads.sh administrator for an enrollment code.

Options:
  --code <code>       Code in argv (may be visible in shell history/process lists)
  --code-stdin        Read one line from stdin
  --non-interactive   Never prompt
  --api-url <url>     API base (default: https://api.uploads.sh)
  --path <file>       Config destination
  --force             Replace existing saved credentials
  --no-check          Skip doctor verification
`;

export function validateEnrollmentCode(raw: string): string {
  const code = raw.trim();
  if (!/^upe_[A-Za-z0-9_-]{20,}$/.test(code)) throw new UsageError("invalid enrollment code");
  return code;
}

async function readLine(): Promise<string> {
  let out = "";
  for await (const chunk of stdin) {
    out += String(chunk);
    if (out.includes("\n")) break;
  }
  return out.split(/\r?\n/, 1)[0] ?? "";
}

async function hiddenPrompt(): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return readLine();
  stdout.write("Enrollment code: ");
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      stdin.off("data", onData);
      stdin.off("error", onError);
      try {
        stdin.setRawMode(false);
      } finally {
        stdin.pause();
        stdout.write("\n");
      }
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003") return done(new UsageError("login cancelled"));
        if (char === "\u007f") value = value.slice(0, -1);
        else value += char;
      }
    };
    const onError = (err: Error) => done(err);
    stdin.on("data", onData);
    stdin.on("error", onError);
  });
}

export async function resolveEnrollmentCode(
  parsed: ReturnType<typeof parseCommandArgs>,
  io: { isTTY: boolean; readLine: () => Promise<string>; hiddenPrompt: () => Promise<string> } = {
    isTTY: Boolean(stdin.isTTY),
    readLine,
    hiddenPrompt,
  },
): Promise<string> {
  const direct = flagString(parsed.flags, "--code");
  const env = process.env.UPLOADS_ENROLLMENT_CODE;
  const fromStdin = flagBool(parsed.flags, "--code-stdin");
  const sources = [Boolean(direct), Boolean(env), fromStdin].filter(Boolean).length;
  if (sources > 1) throw new UsageError("provide enrollment code through only one source");
  if (direct) return validateEnrollmentCode(direct);
  if (env) return validateEnrollmentCode(env);
  if (fromStdin) return validateEnrollmentCode(await io.readLine());
  if (flagBool(parsed.flags, "--non-interactive"))
    throw new UsageError("enrollment code required in non-interactive mode");
  if (!io.isTTY) return validateEnrollmentCode(await io.readLine());
  return validateEnrollmentCode(await io.hiddenPrompt());
}

export async function runLogin(
  args: string[],
  opts: { json?: boolean; apiUrl?: string },
  help = false,
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (help || parsed.help) {
    process.stderr.write(HELP);
    return 0;
  }
  const apiUrl = flagString(parsed.flags, "--api-url") ?? opts.apiUrl ?? "https://api.uploads.sh";
  const path = flagString(parsed.flags, "--path") ?? resolveConfigPath();
  const force = flagBool(parsed.flags, "--force");
  const existing = loadConfigFile(path);
  if (existing.UPLOADS_TOKEN && !force)
    throw new UsageError(`credentials already exist in ${path}; use --force to replace them`);
  if (process.env.UPLOADS_TOKEN && !force)
    throw new UsageError(
      "UPLOADS_TOKEN is already set in the environment; unset it or use --force",
    );
  const code = await resolveEnrollmentCode(parsed);
  const result = await exchangeEnrollment(apiUrl, code);
  const encoded = workspaceFromToken(result.token);
  if (!encoded || encoded !== result.workspace || /[\r\n]/.test(result.token))
    throw new UsageError("enrollment returned invalid credentials");
  const savedApiUrl = result.apiUrl ?? apiUrl;
  const write = writeConfigKeys(
    path,
    {
      UPLOADS_API_URL: savedApiUrl,
      UPLOADS_WORKSPACE: result.workspace,
      UPLOADS_TOKEN: result.token,
    },
    { force },
  );
  if (
    !["UPLOADS_API_URL", "UPLOADS_WORKSPACE", "UPLOADS_TOKEN"].every((key) =>
      write.updated.includes(key),
    )
  )
    throw new UsageError("credentials were not fully written; retry with --force");
  const checked = !flagBool(parsed.flags, "--no-check");
  let doctor = { ok: true, error: undefined as string | undefined };
  if (checked) {
    try {
      const client = createUploadsClient({
        apiUrl: savedApiUrl,
        workspace: result.workspace,
        token: result.token,
      });
      const health = await client.health();
      if (!health.ok) throw new Error("API unhealthy");
      await client.list({ limit: 1 });
    } catch (err) {
      doctor = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  const payload = {
    ok: doctor.ok,
    configPath: path,
    workspace: result.workspace,
    token: redactToken(result.token),
    doctor: checked ? doctor : { skipped: true },
  };
  if (opts.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  else {
    process.stdout.write(
      `saved credentials to ${path}\nworkspace: ${result.workspace}\ntoken: ${redactToken(result.token)}\n`,
    );
    process[doctor.ok ? "stdout" : "stderr"].write(
      `doctor: ${checked ? (doctor.ok ? "ok" : `failed — ${doctor.error}`) : "skipped"}\n`,
    );
  }
  return doctor.ok ? 0 : 1;
}
