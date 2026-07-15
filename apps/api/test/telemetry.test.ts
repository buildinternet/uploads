/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATION = "migrations/20260715120000_uploads_cli_observability.sql";

function env(options: { db?: D1Database; telemetryDisabled?: string } = {}) {
  return {
    DB: options.db,
    TELEMETRY_DISABLED: options.telemetryDisabled,
    REGISTRY: { get: async () => null, put: async () => undefined },
  } as unknown as Env;
}

describe("POST /v1/telemetry", () => {
  it("stores a sanitized event in uploads_telemetry_events", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const res = await app.request(
        "http://localhost/v1/telemetry",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            anonId: "11111111-2222-3333-4444-555555555555",
            timestamp: 1_700_000_000_000,
            surface: "cli",
            clientKind: "external",
            command: "put",
            exitCode: 3,
            durationMs: 120,
            errorCode: "KEY_POLICY",
            cliVersion: "0.10.0",
            os: "darwin",
            arch: "arm64",
            runtime: "node-22.0.0",
          }),
        },
        env({ db: database(sqlite) }),
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true });

      const row = sqlite.db
        .prepare("SELECT * FROM uploads_telemetry_events WHERE command = ?")
        .get("put") as Record<string, unknown>;
      expect(row).toMatchObject({
        anon_id: "11111111-2222-3333-4444-555555555555",
        surface: "cli",
        command: "put",
        exit_code: 3,
        error_code: "KEY_POLICY",
        cli_version: "0.10.0",
      });
      expect(String(row.id)).toMatch(/^tel_/);
    } finally {
      sqlite.close();
    }
  });

  it("drops unknown error codes", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const res = await app.request(
        "http://localhost/v1/telemetry",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            anonId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            surface: "mcp",
            clientKind: "not-a-kind",
            command: "tool put",
            errorCode: "HACKER_CODE",
            cliVersion: "0.10.0",
          }),
        },
        env({ db: database(sqlite) }),
      );
      expect(res.status).toBe(202);
      const row = sqlite.db
        .prepare("SELECT client_kind, error_code FROM uploads_telemetry_events LIMIT 1")
        .get() as { client_kind: string; error_code: string | null };
      expect(row.client_kind).toBe("external");
      expect(row.error_code).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("rejects missing fields; honors kill switch; fails open without DB", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const bad = await app.request(
        "http://localhost/v1/telemetry",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command: "put" }),
        },
        env({ db: database(sqlite) }),
      );
      expect(bad.status).toBe(400);

      const disabled = await app.request(
        "http://localhost/v1/telemetry",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            anonId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            surface: "cli",
            command: "put",
            cliVersion: "0.10.0",
          }),
        },
        env({ db: database(sqlite), telemetryDisabled: "1" }),
      );
      expect(disabled.status).toBe(202);
      expect(await disabled.json()).toEqual({ ok: true, disabled: true });
    } finally {
      sqlite.close();
    }

    const noDb = await app.request(
      "http://localhost/v1/telemetry",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          anonId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          surface: "cli",
          command: "doctor",
          cliVersion: "0.10.0",
        }),
      },
      env({}),
    );
    expect(noDb.status).toBe(202);
  });
});
