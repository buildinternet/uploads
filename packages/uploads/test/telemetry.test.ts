import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getOrCreateAnonId,
  isTelemetryEnabled,
  setTelemetryEnabled,
  telemetryCommandName,
  telemetryStatus,
  recordEvent,
  maybeShowFirstRunNotice,
  errorCodeFromUnknown,
} from "../src/telemetry.js";
import { UploadsError } from "../src/errors.js";
import { UsageError } from "../src/cli-args.js";

// Allow isTelemetryEnabled / recordEvent during this file only.
process.env.UPLOADS_TELEMETRY_TEST = "1";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "uploads-telemetry-"));
}

function clearOptOutEnv(): void {
  delete process.env.UPLOADS_TELEMETRY_DISABLED;
  delete process.env.DO_NOT_TRACK;
  process.env.UPLOADS_CLIENT_KIND = "external";
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
  delete process.env.CLAUDECODE;
  delete process.env.CLAUDE_CODE;
  delete process.env.CURSOR_AGENT;
  delete process.env.CURSOR_TRACE_ID;
}

describe("telemetryCommandName", () => {
  it("returns root for simple commands and ignores file args", () => {
    expect(telemetryCommandName(["node", "uploads", "put", "./secret.png"])).toBe("put");
    expect(telemetryCommandName(["node", "uploads", "attach", "a.png", "b.png"])).toBe("attach");
  });

  it("includes subcommand for nested commands only", () => {
    expect(telemetryCommandName(["node", "uploads", "config", "set", "UPLOADS_TOKEN", "x"])).toBe(
      "config set",
    );
    expect(telemetryCommandName(["node", "uploads", "gallery", "create", "--title", "x"])).toBe(
      "gallery create",
    );
    expect(telemetryCommandName(["node", "uploads", "telemetry", "disable"])).toBe(
      "telemetry disable",
    );
  });

  it("skips value-bearing global flags and their values", () => {
    expect(
      telemetryCommandName([
        "node",
        "uploads",
        "--token",
        "up_secret_token",
        "--api-url",
        "https://api.example",
        "put",
        "./x.png",
      ]),
    ).toBe("put");
    expect(telemetryCommandName(["node", "uploads", "--env-file", "/path/to/.env", "doctor"])).toBe(
      "doctor",
    );
  });

  it("handles root / flags-only", () => {
    expect(telemetryCommandName(["node", "uploads"])).toBe("(root)");
    expect(telemetryCommandName(["node", "uploads", "--json", "doctor"])).toBe("doctor");
  });
});

describe("isTelemetryEnabled / setTelemetryEnabled", () => {
  const prevDisabled = process.env.UPLOADS_TELEMETRY_DISABLED;
  const prevDnt = process.env.DO_NOT_TRACK;

  afterEach(() => {
    if (prevDisabled === undefined) delete process.env.UPLOADS_TELEMETRY_DISABLED;
    else process.env.UPLOADS_TELEMETRY_DISABLED = prevDisabled;
    if (prevDnt === undefined) delete process.env.DO_NOT_TRACK;
    else process.env.DO_NOT_TRACK = prevDnt;
  });

  it("opts out via UPLOADS_TELEMETRY_DISABLED", () => {
    const dir = tempDir();
    process.env.UPLOADS_TELEMETRY_DISABLED = "1";
    delete process.env.DO_NOT_TRACK;
    expect(isTelemetryEnabled(dir)).toBe(false);
  });

  it("opts out via DO_NOT_TRACK=1", () => {
    const dir = tempDir();
    delete process.env.UPLOADS_TELEMETRY_DISABLED;
    process.env.DO_NOT_TRACK = "1";
    expect(isTelemetryEnabled(dir)).toBe(false);
  });

  it("opts out via disable file", () => {
    const dir = tempDir();
    clearOptOutEnv();
    expect(isTelemetryEnabled(dir)).toBe(true);
    setTelemetryEnabled(false, dir);
    expect(isTelemetryEnabled(dir)).toBe(false);
    setTelemetryEnabled(true, dir);
    expect(isTelemetryEnabled(dir)).toBe(true);
  });
});

describe("getOrCreateAnonId", () => {
  it("persists a stable UUID", () => {
    const dir = tempDir();
    const a = getOrCreateAnonId(dir);
    const b = getOrCreateAnonId(dir);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(existsSync(join(dir, "telemetry-id"))).toBe(true);
  });
});

describe("recordEvent", () => {
  const prevDisabled = process.env.UPLOADS_TELEMETRY_DISABLED;
  const prevDnt = process.env.DO_NOT_TRACK;

  beforeEach(() => {
    clearOptOutEnv();
  });

  afterEach(() => {
    if (prevDisabled === undefined) delete process.env.UPLOADS_TELEMETRY_DISABLED;
    else process.env.UPLOADS_TELEMETRY_DISABLED = prevDisabled;
    if (prevDnt === undefined) delete process.env.DO_NOT_TRACK;
    else process.env.DO_NOT_TRACK = prevDnt;
  });

  it("POSTs a PII-clean payload and skips when disabled", async () => {
    const dir = tempDir();
    clearOptOutEnv();
    const bodies: unknown[] = [];
    let resolvePosted!: () => void;
    const posted = new Promise<void>((r) => {
      resolvePosted = r;
    });
    recordEvent(
      {
        surface: "cli",
        command: "put",
        exitCode: 3,
        durationMs: 42,
        errorCode: "KEY_POLICY",
      },
      {
        dataDir: dir,
        apiUrl: "https://api.example.test",
        version: "0.10.0",
        now: 1_700_000_000_000,
        fetchImpl: async (input, init) => {
          expect(String(input)).toBe("https://api.example.test/v1/telemetry");
          expect(init?.method).toBe("POST");
          bodies.push(JSON.parse(String(init?.body)));
          resolvePosted();
          return new Response(JSON.stringify({ ok: true }), { status: 202 });
        },
      },
    );
    await posted;

    expect(bodies).toHaveLength(1);
    const body = bodies[0] as Record<string, unknown>;
    expect(body.command).toBe("put");
    expect(body.surface).toBe("cli");
    expect(body.exitCode).toBe(3);
    expect(body.durationMs).toBe(42);
    expect(body.errorCode).toBe("KEY_POLICY");
    expect(body.cliVersion).toBe("0.10.0");
    expect(body.anonId).toBeTruthy();
    // Must never include path-like content in the envelope keys we control.
    expect(JSON.stringify(body)).not.toMatch(/secret|\.png|token|up_/i);

    setTelemetryEnabled(false, dir);
    expect(() =>
      recordEvent(
        { surface: "cli", command: "put" },
        {
          dataDir: dir,
          fetchImpl: async () => {
            throw new Error("should not fetch");
          },
        },
      ),
    ).not.toThrow();
  });

  it("never throws on network failure", async () => {
    const dir = tempDir();
    expect(() =>
      recordEvent(
        { surface: "cli", command: "doctor" },
        {
          dataDir: dir,
          fetchImpl: async () => {
            throw new Error("network down");
          },
        },
      ),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe("maybeShowFirstRunNotice", () => {
  const prevDisabled = process.env.UPLOADS_TELEMETRY_DISABLED;

  afterEach(() => {
    if (prevDisabled === undefined) delete process.env.UPLOADS_TELEMETRY_DISABLED;
    else process.env.UPLOADS_TELEMETRY_DISABLED = prevDisabled;
  });

  it("prints once then is silent", () => {
    const dir = tempDir();
    clearOptOutEnv();
    const lines: string[] = [];
    maybeShowFirstRunNotice({
      dataDir: dir,
      interactive: true,
      write: (t) => lines.push(t),
    });
    expect(lines.join("")).toMatch(/anonymous usage/);
    expect(existsSync(join(dir, "telemetry-notice-shown"))).toBe(true);
    const first = lines.length;
    maybeShowFirstRunNotice({
      dataDir: dir,
      interactive: true,
      write: (t) => lines.push(t),
    });
    expect(lines.length).toBe(first);
  });
});

describe("telemetryStatus / errorCodeFromUnknown", () => {
  it("reports disable reason", () => {
    const dir = tempDir();
    setTelemetryEnabled(false, dir);
    const s = telemetryStatus({ dataDir: dir, apiUrl: "https://api.uploads.sh" });
    expect(s.enabled).toBe(false);
    expect(s.reason).toMatch(/telemetry-disabled/);
    expect(s.endpoint).toBe("https://api.uploads.sh/v1/telemetry");
  });

  it("maps allowlisted errors only", () => {
    expect(errorCodeFromUnknown(new UploadsError("nope", "UNAUTHORIZED", 401))).toBe(
      "UNAUTHORIZED",
    );
    expect(errorCodeFromUnknown(new UsageError("bad"))).toBe("USAGE");
    expect(errorCodeFromUnknown(new Error("boom"))).toBeUndefined();
    expect(errorCodeFromUnknown(Object.assign(new Error("x"), { code: "SECRET_PATH" }))).toBe(
      undefined,
    );
  });

  it("rejects non-UUID anon ids and rewrites the file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "telemetry-id"), "not-a-uuid\n");
    const id = getOrCreateAnonId(dir);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(getOrCreateAnonId(dir)).toBe(id);
  });

  it("writes disable marker content", () => {
    const dir = tempDir();
    setTelemetryEnabled(false, dir);
    expect(readFileSync(join(dir, "telemetry-disabled"), "utf8")).toMatch(/disabled/);
  });
});
