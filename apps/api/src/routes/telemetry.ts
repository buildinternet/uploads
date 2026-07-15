/**
 * Anonymous CLI / MCP usage pings → D1 `uploads_telemetry_events`.
 * PII-clean: command names, versions, OS, exit codes only.
 */
import { RateLimitedError, ValidationError } from "@uploads/errors";
import { Hono } from "hono";
import {
  MAX_ANON_ID,
  MAX_COMMAND,
  MAX_STRING,
  MAX_TELEMETRY_BODY_BYTES,
  MAX_VERSION,
  clampInt,
  envFlagOn,
  newId,
  pickClientKind,
  pickErrorCode,
  pickSurface,
  readJsonObjectBody,
  sanitizeInt,
  sanitizeString,
  SURFACES,
} from "../cli-intake";
import type { WorkspaceVars } from "../workspace";

export const telemetry = new Hono<WorkspaceVars>();

/** Exit codes observed from CLIs are small signed/unsigned ints. */
const MAX_EXIT_CODE = 255;
const MIN_EXIT_CODE = -128;
/** Cap recorded duration at 24h (ms). */
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
/** Timestamps: unix ms within a reasonable window around "now". */
const MAX_TS_SKEW_MS = 365 * 24 * 60 * 60 * 1000;

telemetry.post("/", async (c) => {
  if (envFlagOn(c.env.TELEMETRY_DISABLED)) {
    return c.json({ ok: true, disabled: true }, 202);
  }

  // IP rate limit via WRITE_LIMITER (anonymous key — no workspace on this route).
  const limiter = c.env.WRITE_LIMITER;
  if (limiter) {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const { success } = await limiter.limit({ key: `cli-telemetry:${ip}` });
    if (!success) {
      c.header("Retry-After", "60");
      throw new RateLimitedError("too many telemetry events; retry shortly");
    }
  }

  if (!c.env.DB) return c.json({ ok: true }, 202);

  const body = await readJsonObjectBody(c.req.raw, MAX_TELEMETRY_BODY_BYTES);

  const surface = pickSurface(body.surface, "");
  const command = sanitizeString(body.command, MAX_COMMAND);
  const anonId = sanitizeString(body.anonId, MAX_ANON_ID);
  const cliVersion = sanitizeString(body.cliVersion, MAX_VERSION);
  if (!surface || !SURFACES.has(surface) || !command || !anonId || !cliVersion) {
    throw new ValidationError("missing or invalid telemetry fields");
  }

  const now = Date.now();
  const timestamp =
    clampInt(sanitizeInt(body.timestamp), now - MAX_TS_SKEW_MS, now + MAX_TS_SKEW_MS) ?? now;
  const exitCode = clampInt(sanitizeInt(body.exitCode), MIN_EXIT_CODE, MAX_EXIT_CODE);
  const durationMs = clampInt(sanitizeInt(body.durationMs), 0, MAX_DURATION_MS);

  try {
    await c.env.DB.prepare(
      `INSERT INTO uploads_telemetry_events (
        id, anon_id, timestamp, surface, client_kind, agent_name,
        command, exit_code, duration_ms, error_code, cli_version,
        os, arch, runtime
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        newId("tel"),
        anonId,
        timestamp,
        surface,
        pickClientKind(body.clientKind),
        sanitizeString(body.agentName, 64),
        command,
        exitCode,
        durationMs,
        pickErrorCode(body.errorCode),
        cliVersion,
        sanitizeString(body.os, MAX_STRING),
        sanitizeString(body.arch, MAX_STRING),
        sanitizeString(body.runtime, MAX_STRING),
      )
      .run();
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "uploads_telemetry_events insert failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return c.json({ ok: true }, 202);
});
