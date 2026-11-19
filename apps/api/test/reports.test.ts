/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { SqliteD1, database } from "./helpers/sqlite-d1";
import { MAX_ATTACHMENT_BYTES } from "../src/routes/reports";

const MIGRATION = [
  "migrations/20260715120000_uploads_cli_observability.sql",
  "migrations/20261119120000_report_context.sql",
];

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
    sent?: Array<{ to: string; subject: string; text?: string }>;
    limiterKeys?: string[];
  } = {},
) {
  return {
    EMAIL: options.sent
      ? {
          send: async (m: { to: string; subject: string; text?: string }) => {
            options.sent!.push(m);
          },
        }
      : undefined,
    DB: options.db,
    UPLOADS_DEFAULT: options.r2,
    REPORTS_DISABLED: options.reportsDisabled,
    INVITE_LIMITER:
      options.inviteAllowed === undefined
        ? undefined
        : {
            limit: async ({ key }: { key: string }) => {
              options.limiterKeys?.push(key);
              return { success: options.inviteAllowed };
            },
          },
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

  it("fails when DB is absent (no orphan attachment success)", async () => {
    const r2 = fakeR2();
    const res = await app.request(
      "http://localhost/v1/reports",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "still long enough to send",
          attachment: { filename: "trace.log", body: "log line" },
        }),
      },
      env({ r2 }),
    );
    expect(res.status).toBe(503);
    expect(r2.objects.size).toBe(0);
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
  it("emails the operator with contact and follow-up consent", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    const sent: Array<{ to: string; subject: string; text?: string }> = [];
    try {
      const res = await app.request(
        "http://localhost/v1/reports",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: "acme/web is bound to another workspace, please reassign",
            type: "other",
            contact: "dev@example.com",
            followUpOk: true,
            surface: "cli",
            // Public callers can't set relay identity, even by header.
          }),
        },
        env({ db: database(sqlite), sent }),
      );
      expect(res.status).toBe(202);
      const { id } = (await res.json()) as { id: string };
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe("hi@uploads.sh");
      expect(sent[0]!.text).toContain("OK to follow up: yes");
      expect(sent[0]!.text).toContain("dev@example.com");
      const row = sqlite.db
        .prepare("SELECT follow_up_ok, workspace FROM uploads_cli_reports WHERE id = ?")
        .get(id) as { follow_up_ok: number; workspace: string | null };
      expect(row).toEqual({ follow_up_ok: 1, workspace: null });
    } finally {
      sqlite.close();
    }
  });

  it("trusts relay identity only over the service binding, and limits per workspace", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    const limiterKeys: string[] = [];
    const headers = {
      "content-type": "application/json",
      "x-uploads-workspace": "acme",
      "x-uploads-user-id": "user-1",
    };
    const body = JSON.stringify({ message: "feedback from an agent", surface: "mcp" });
    try {
      const pub = await app.request(
        "http://localhost/v1/reports",
        { method: "POST", headers, body },
        env({ db: database(sqlite), inviteAllowed: true, limiterKeys }),
      );
      const relayed = await app.request(
        "https://api.internal/v1/reports",
        { method: "POST", headers, body },
        env({ db: database(sqlite), inviteAllowed: true, limiterKeys }),
      );
      const pubId = ((await pub.json()) as { id: string }).id;
      const relayId = ((await relayed.json()) as { id: string }).id;
      const pick = (id: string) =>
        sqlite.db
          .prepare("SELECT workspace, user_id FROM uploads_cli_reports WHERE id = ?")
          .get(id);
      expect(pick(pubId)).toEqual({ workspace: null, user_id: null });
      expect(pick(relayId)).toEqual({ workspace: "acme", user_id: "user-1" });
      expect(limiterKeys).toEqual(["cli-report:unknown", "mcp-report:acme"]);
    } finally {
      sqlite.close();
    }
  });
});
