/// <reference types="node" />

import { describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { ABUSE_NOTIFY_TO, notifyAbuseReport, withinAbuseNotifyBudget } from "../src/abuse-email";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATION = "migrations/20260722120000_abuse_reports.sql";

function env(
  options: {
    db?: D1Database;
    abuseDisabled?: string;
    inviteAllowed?: boolean;
    email?: { send: ReturnType<typeof vi.fn> };
  } = {},
) {
  return {
    DB: options.db,
    ABUSE_DISABLED: options.abuseDisabled,
    INVITE_LIMITER:
      options.inviteAllowed === undefined
        ? undefined
        : { limit: async () => ({ success: options.inviteAllowed }) },
    EMAIL: options.email,
    REGISTRY: { get: async () => null, put: async () => undefined },
    WEB_ORIGIN: "https://uploads.sh",
  } as unknown as Env;
}

async function postAbuse(body: Record<string, unknown>, e: Env) {
  return app.request(
    "http://localhost/v1/abuse",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    e,
  );
}

describe("POST /v1/abuse", () => {
  it("stores a report", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const res = await postAbuse(
        {
          pageUrl: "https://uploads.sh/f/default/screenshots/demo.png",
          workspace: "default",
          key: "screenshots/demo.png",
          reason: "abuse",
          message: "This looks like phishing",
          contact: "reporter@example.com",
          surface: "web",
        },
        env({ db: database(sqlite) }),
      );
      expect(res.status).toBe(202);
      const json = (await res.json()) as { ok: boolean; id: string };
      expect(json.ok).toBe(true);
      expect(json.id).toMatch(/^ab_/);

      const row = sqlite.db
        .prepare("SELECT * FROM abuse_reports WHERE id = ?")
        .get(json.id) as Record<string, unknown>;
      expect(row.reason).toBe("abuse");
      expect(row.workspace).toBe("default");
      expect(row.object_key).toBe("screenshots/demo.png");
      expect(row.contact).toBe("reporter@example.com");
    } finally {
      sqlite.close();
    }
  });

  it("accepts reports without a message when reason is not other", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const res = await postAbuse(
        {
          pageUrl: "https://uploads.sh/f/acme/f/abc/shot.webp",
          workspace: "acme",
          key: "f/abc/shot.webp",
          reason: "spam",
        },
        env({ db: database(sqlite) }),
      );
      expect(res.status).toBe(202);
      const { id } = (await res.json()) as { id: string };
      const row = sqlite.db
        .prepare("SELECT reason, message FROM abuse_reports WHERE id = ?")
        .get(id) as { reason: string; message: string | null };
      expect(row.reason).toBe("spam");
      expect(row.message).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("rejects bad other/message, bad urls, kill switch, rate limit", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      const e = env({ db: database(sqlite) });
      expect(
        (
          await postAbuse(
            { pageUrl: "https://uploads.sh/f/a/b.png", reason: "other", message: "no" },
            e,
          )
        ).status,
      ).toBe(400);
      expect((await postAbuse({ pageUrl: "javascript:alert(1)", reason: "abuse" }, e)).status).toBe(
        400,
      );
      expect(
        (
          await postAbuse(
            { pageUrl: "https://uploads.sh/f/a/b.png", reason: "abuse" },
            env({ db: database(sqlite), abuseDisabled: "1" }),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await postAbuse(
            { pageUrl: "https://uploads.sh/f/a/b.png", reason: "abuse" },
            env({ db: database(sqlite), inviteAllowed: false }),
          )
        ).status,
      ).toBe(429);
    } finally {
      sqlite.close();
    }
  });
});

describe("notifyAbuseReport", () => {
  it("emails abuse@", async () => {
    const send = vi.fn(
      async (_message: {
        to: string;
        from: { name: string; email: string };
        subject: string;
        text?: string;
        html?: string;
      }) => undefined,
    );
    await notifyAbuseReport(
      { EMAIL: { send }, WEB_ORIGIN: "https://uploads.sh" },
      {
        id: "ab_test",
        reason: "copyright",
        message: "mine",
        contact: "a@b.co",
        pageUrl: "https://uploads.sh/f/acme/x.png",
        workspace: "acme",
        objectKey: "x.png",
        surface: "web",
        createdAt: "2026-07-22T00:00:00.000Z",
      },
    );
    expect(send).toHaveBeenCalledTimes(1);
    const args = send.mock.calls[0]?.[0];
    expect(args?.to).toBe(ABUSE_NOTIFY_TO);
    expect(args?.from.email).toBe("noreply@uploads.sh");
    expect(args?.subject).toMatch(/^\[abuse\] copyright:/);
  });
});

describe("withinAbuseNotifyBudget", () => {
  it("fails open without KV and caps when at max", async () => {
    expect(await withinAbuseNotifyBudget(undefined, 5)).toBe(true);
    const store = new Map<string, string>();
    const kv = {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    };
    expect(await withinAbuseNotifyBudget(kv, 1)).toBe(true);
    expect(await withinAbuseNotifyBudget(kv, 1)).toBe(false);
  });
});
