/**
 * Anonymous CLI / MCP usage pings → D1 `uploads_telemetry_events`.
 * PII-clean: command names, versions, OS, exit codes only.
 */
import { ValidationError } from "@uploads/errors";
import { Hono } from "hono";
import {
  MAX_ANON_ID,
  MAX_COMMAND,
  MAX_STRING,
  MAX_VERSION,
  envFlagOn,
  newId,
  pickClientKind,
  pickErrorCode,
  pickSurface,
  sanitizeInt,
  sanitizeString,
  SURFACES,
} from "../cli-intake";
import type { WorkspaceVars } from "../workspace";

export const telemetry = new Hono<WorkspaceVars>();

telemetry.post("/", async (c) => {
  if (envFlagOn(c.env.TELEMETRY_DISABLED)) {
    return c.json({ ok: true, disabled: true }, 202);
  }
  if (!c.env.DB) return c.json({ ok: true }, 202);

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    throw new ValidationError("invalid JSON body");
  }

  const surface = pickSurface(body.surface, "");
  const command = sanitizeString(body.command, MAX_COMMAND);
  const anonId = sanitizeString(body.anonId, MAX_ANON_ID);
  const cliVersion = sanitizeString(body.cliVersion, MAX_VERSION);
  if (!surface || !SURFACES.has(surface) || !command || !anonId || !cliVersion) {
    throw new ValidationError("missing or invalid telemetry fields");
  }

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
        sanitizeInt(body.timestamp) ?? Date.now(),
        surface,
        pickClientKind(body.clientKind),
        sanitizeString(body.agentName, 64),
        command,
        sanitizeInt(body.exitCode),
        sanitizeInt(body.durationMs),
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
