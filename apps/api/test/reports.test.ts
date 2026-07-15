/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { SqliteD1, database } from "./helpers/sqlite-d1";
import { MAX_ATTACHMENT_BYTES } from "../src/routes/reports";

const MIGRATION = "migrations/20260715120000_uploads_cli_observability.sql";

function fakeR2() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async put(key: string, value: ArrayBuffer | ArrayBufferView | string) {
      const body =
        typeof value === "string"
          ? new TextEncoder().encode(value)
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      objects.set(key, body);
      return { key } as R2Object;
    },
  };
}

function env(
  options: {
    db?: D1Database;
    r2?: ReturnType<typeof fakeR2>;
    reportsDisabled?: string;
    inviteAllowed?: boolean;
  } = {},
) {
  return {
    DB: options.db,
    UPLOADS_DEFAULT: options.r2,
    REPORTS_DISABLED: options.reportsDisabled,
    INVITE_LIMITER:
      options.inviteAllowed === undefined
        ? undefined
        : { limit: async () => ({ success: options.inviteAllowed }) },
    REGISTRY: { get: async () => null, put: async () => undefined },
  } as unknown as Env;
}

describe("POST /v1/reports", () => {
  it("stores metadata in uploads_cli_reports and log in R2", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    const r2 = fakeR2();
    try {
      const res = await app.request(
        "http://localhost/v1/reports",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: "put fails with KEY_POLICY on custom prefixes",
            type: "error",
            contact: "dev@example.com",
            surface: "cli",
            command: "put",
            errorCode: "KEY_POLICY",
            cliVersion: "0.10.0",
            attachment: {
              filename: "trace.log",
              contentType: "text/plain",
              body: "Error: KEY_POLICY\n  at put\n",
            },
          }),
        },
        env({ db: database(sqlite), r2 }),
      );
      expect(res.status).toBe(202);
      const json = (await res.json()) as { ok: boolean; id: string; hasAttachment: boolean };
      expect(json.ok).toBe(true);
      expect(json.id).toMatch(/^rpt_/);
      expect(json.hasAttachment).toBe(true);

      const row = sqlite.db
        .prepare("SELECT * FROM uploads_cli_reports WHERE id = ?")
        .get(json.id) as Record<string, unknown>;
      expect(row.type).toBe("error");
      expect(row.error_code).toBe("KEY_POLICY");
      expect(String(row.attachment_key)).toBe(`_internal/uploads-cli-reports/${json.id}/trace.log`);
      expect(new TextDecoder().decode(r2.objects.get(String(row.attachment_key))!)).toMatch(
        /KEY_POLICY/,
      );
    } finally {
      sqlite.close();
    }
  });

  it("rejects short messages, oversized attachments, kill switch, rate limit", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    const r2 = fakeR2();
    try {
      expect(
        (
          await app.request(
            "http://localhost/v1/reports",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ message: "hi" }),
            },
            env({ db: database(sqlite), r2 }),
          )
        ).status,
      ).toBe(400);

      expect(
        (
          await app.request(
            "http://localhost/v1/reports",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                message: "long enough message here",
                attachment: { filename: "big.log", body: "x".repeat(MAX_ATTACHMENT_BYTES + 1) },
              }),
            },
            env({ db: database(sqlite), r2 }),
          )
        ).status,
      ).toBe(413);

      expect(
        (
          await app.request(
            "http://localhost/v1/reports",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ message: "still long enough" }),
            },
            env({ db: database(sqlite), reportsDisabled: "1" }),
          )
        ).status,
      ).toBe(400);

      expect(
        (
          await app.request(
            "http://localhost/v1/reports",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ message: "still long enough" }),
            },
            env({ db: database(sqlite), inviteAllowed: false }),
          )
        ).status,
      ).toBe(429);
    } finally {
      sqlite.close();
    }
  });

  it("sanitizes path traversal in attachment filenames", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    const r2 = fakeR2();
    try {
      const res = await app.request(
        "http://localhost/v1/reports",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: "path traversal attempt in filename",
            attachment: { filename: "../../etc/passwd", body: "not real" },
          }),
        },
        env({ db: database(sqlite), r2 }),
      );
      expect(res.status).toBe(202);
      const json = (await res.json()) as { id: string };
      const row = sqlite.db
        .prepare("SELECT attachment_key FROM uploads_cli_reports WHERE id = ?")
        .get(json.id) as { attachment_key: string };
      expect(row.attachment_key).toBe(`_internal/uploads-cli-reports/${json.id}/passwd`);
    } finally {
      sqlite.close();
    }
  });
});
