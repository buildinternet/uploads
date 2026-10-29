import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { CLASSIFIER_RETRY_CAP, runClassifierRetrySweep } from "./classifier-retry-sweep";
import {
  CLASSIFIER_SKIP_MIN_BYTES,
  CLASSIFIER_VERSION,
  OPENROUTER_DECISIONS_URL,
} from "./classifier";
import { getFileMetadata } from "./file-metadata";
import { storage } from "./storage";
import { WEEKLY_DIGEST_CRON } from "./weekly-digest-sweep";
import type { WorkspaceRecord } from "./workspace";
import { FakeR2Bucket } from "../test/fake-r2";
import { database, SqliteD1 } from "../test/helpers/sqlite-d1";

const MIGRATIONS = [
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20260724140000_file_content_hash.sql",
  "migrations/20261028120000_file_events.sql",
  "migrations/20261028140000_blob_hold.sql",
  "migrations/20261028160000_read_gate.sql",
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jevAnswer(choice: string, confidence = 0.9) {
  return { type: "choice", choice, confidence, probabilities: { [choice]: confidence } };
}

const DECIDED = {
  model: "~typesafe/jev-latest",
  answers: {
    kind: jevAnswer("screenshot"),
    surface: jevAnswer("desktop"),
    screen: jevAnswer("settings"),
  },
  usage: {},
};

const FLAGGED = {
  ...DECIDED,
  answers: {
    ...DECIDED.answers,
    secret: jevAnswer("api_key", 0.9),
  },
};

function pngOf(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return bytes;
}

function atLeast(bytes: Uint8Array, min = CLASSIFIER_SKIP_MIN_BYTES): Uint8Array {
  if (bytes.byteLength >= min) return bytes;
  const out = new Uint8Array(min);
  out.set(bytes);
  return out;
}

/** Inside Jev's window, so a retry sends the original bytes. */
const FITTING_PNG = atLeast(pngOf(400, 280));

function wsRecord(name: string, over: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    provider: "r2",
    bucket: "uploads-default",
    binding: "UPLOADS_DEFAULT",
    prefix: `${name}/`,
    publicBaseUrl: "https://storage.uploads.sh",
    name,
    ...over,
  };
}

function fakeRegistry(records: Record<string, WorkspaceRecord>) {
  const store = new Map<string, WorkspaceRecord>(
    Object.entries(records).map(([name, record]) => [`ws:${name}`, record]),
  );
  return {
    get: (async (key: string) => store.get(key) ?? null) as unknown as KVNamespace["get"],
    list: (async (opts: { prefix?: string } = {}) => ({
      keys: [...store.keys()]
        .filter((key) => !opts.prefix || key.startsWith(opts.prefix))
        .map((name) => ({ name })),
      list_complete: true,
    })) as unknown as KVNamespace["list"],
  };
}

interface DecisionBody {
  questions?: Record<string, unknown>;
  state?: unknown[];
}

function filenameOf(body: DecisionBody): string {
  const first = body.state?.[0];
  return typeof first === "string" ? first : "";
}

function stubDecisions(respond: (body: DecisionBody, call: number) => unknown) {
  const calls: DecisionBody[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url !== OPENROUTER_DECISIONS_URL) {
        return new Response("<probe/>", {
          status: 200,
          headers: {
            "content-type": String(url).endsWith(".xml") ? "application/xml" : "image/svg+xml",
            "content-security-policy": "default-src 'none'; sandbox",
            "x-content-type-options": "nosniff",
          },
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as DecisionBody;
      calls.push(body);
      const payload = respond(body, calls.length);
      if (typeof payload === "number") return new Response("nope", { status: payload });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

function harness(
  records: Record<string, WorkspaceRecord>,
  respond: (body: DecisionBody, call: number) => unknown = () => DECIDED,
) {
  const sqlite = new SqliteD1(MIGRATIONS);
  const bucket = new FakeR2Bucket();
  const calls = stubDecisions(respond);
  const env = {
    DB: database(sqlite),
    REGISTRY: fakeRegistry(records),
    UPLOADS_DEFAULT: bucket,
    FLAGS: {
      getBooleanValue: async (flag: string) =>
        flag === "llm-file-classifier" || flag === "upload-holds",
    },
    OPENROUTER_API_KEY: "test-key",
    AI: {
      run: () => {
        throw new Error("workers ai should not run");
      },
      gateway: () => {
        throw new Error("ai gateway should not run");
      },
    },
  } as unknown as Env;
  return { sqlite, bucket, env, calls };
}

function seed(
  sqlite: SqliteD1,
  workspace: string,
  key: string,
  classifier: string,
  updatedAt: string,
) {
  const insert = sqlite.db.prepare(
    `INSERT INTO file_metadata (workspace, object_key, meta_key, meta_value, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  insert.run(workspace, key, "ai.classifier", classifier, updatedAt);
  if (classifier === "failed") {
    insert.run(workspace, key, "ai.error", "timeout", updatedAt);
  }
}

async function putPng(env: Env, ws: WorkspaceRecord, key: string) {
  await (await storage(env, ws)).upload(key, FITTING_PNG, { contentType: "image/png" });
}

function meta(sqlite: SqliteD1, workspace: string, key: string) {
  return getFileMetadata(database(sqlite), workspace, key);
}

function fakeExecutionContext() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.allSettled(pending) };
}

describe("runClassifierRetrySweep", () => {
  it("classifies a failed file and holds it when the decision says so", async () => {
    const acme = wsRecord("acme");
    const { sqlite, bucket, env, calls } = harness({ acme }, (body) => {
      if (body.questions && "area" in body.questions) return { answers: {} };
      return filenameOf(body).includes("secret.png") ? FLAGGED : DECIDED;
    });
    try {
      await putPng(env, acme, "shots/secret.png");
      seed(sqlite, "acme", "shots/secret.png", "failed", "2020-01-01T00:00:00.000Z");
      seed(sqlite, "acme", "shots/done.png", "v5", "2019-01-01T00:00:00.000Z");
      await putPng(env, acme, "shots/clean.png");
      seed(sqlite, "acme", "shots/clean.png", "failed", "2020-01-02T00:00:00.000Z");

      const result = await runClassifierRetrySweep(env);

      expect(result.errors).toEqual([]);
      expect(result.resolved).toBe(2);
      const secret = await meta(sqlite, "acme", "shots/secret.png");
      expect(secret["ai.classifier"]).toBe(CLASSIFIER_VERSION);
      expect(secret["ai.secret"]).toBe("api_key");
      expect(secret["ai.error"]).toBeUndefined();
      expect(secret["ai.hold"]).toBe("pending");
      expect(await meta(sqlite, "acme", "shots/done.png")).toMatchObject({
        "ai.classifier": "v5",
      });
      const clean = await meta(sqlite, "acme", "shots/clean.png");
      expect(clean["ai.classifier"]).toBe(CLASSIFIER_VERSION);
      expect(clean["ai.hold"]).toBeUndefined();
      expect(
        sqlite.db.prepare(`SELECT state FROM blob_hold WHERE workspace = ?`).all("acme") as Array<{
          state: string;
        }>,
      ).toEqual([{ state: "held" }]);
      expect(
        sqlite.db
          .prepare(`SELECT object_key FROM read_gate WHERE lane = 'hosted' ORDER BY object_key`)
          .all() as Array<{ object_key: string }>,
      ).toEqual(expect.arrayContaining([{ object_key: "acme/shots/secret.png" }]));
      expect(bucket.store.has("acme/shots/secret.png")).toBe(true);
      expect(calls.some((call) => call.questions && "area" in call.questions)).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it("stops at the cap and leaves newer failures for the next run", async () => {
    const acme = wsRecord("acme");
    const { sqlite, env, calls } = harness({ acme });
    try {
      const total = CLASSIFIER_RETRY_CAP + 1;
      for (let i = 0; i < total; i++) {
        const key = `shots/${String(i).padStart(2, "0")}.png`;
        await putPng(env, acme, key);
        seed(sqlite, "acme", key, "failed", `2020-01-01T00:00:${String(i).padStart(2, "0")}.000Z`);
      }

      const result = await runClassifierRetrySweep(env);

      expect(result.errors).toEqual([]);
      expect(result.attempted).toBe(CLASSIFIER_RETRY_CAP);
      expect(result.resolved).toBe(CLASSIFIER_RETRY_CAP);
      expect(calls).toHaveLength(CLASSIFIER_RETRY_CAP);
      const newest = `shots/${String(CLASSIFIER_RETRY_CAP).padStart(2, "0")}.png`;
      expect(await meta(sqlite, "acme", newest)).toMatchObject({
        "ai.classifier": "failed",
      });
      expect(await meta(sqlite, "acme", "shots/00.png")).toMatchObject({
        "ai.classifier": CLASSIFIER_VERSION,
      });
    } finally {
      sqlite.close();
    }
  });

  it("does not spend the cap on a missing object or a workspace with classification off", async () => {
    const acme = wsRecord("acme");
    const off = wsRecord("off", { llmClassifierEnabled: false });
    const { sqlite, env, calls } = harness({ acme, off });
    try {
      seed(sqlite, "acme", "shots/gone.png", "failed", "2020-01-01T00:00:00.000Z");
      await putPng(env, off, "shots/off.png");
      seed(sqlite, "off", "shots/off.png", "failed", "2020-01-02T00:00:00.000Z");
      for (let i = 0; i < CLASSIFIER_RETRY_CAP; i++) {
        const key = `shots/${String(i).padStart(2, "0")}.png`;
        await putPng(env, acme, key);
        seed(sqlite, "acme", key, "failed", `2020-01-03T00:00:${String(i).padStart(2, "0")}.000Z`);
      }

      const result = await runClassifierRetrySweep(env);

      expect(result.errors).toEqual([]);
      expect(result.deferred).toBe(2);
      expect(result.attempted).toBe(CLASSIFIER_RETRY_CAP);
      expect(result.resolved).toBe(CLASSIFIER_RETRY_CAP);
      expect(calls).toHaveLength(CLASSIFIER_RETRY_CAP);
      expect(await meta(sqlite, "acme", "shots/gone.png")).toMatchObject({
        "ai.classifier": "failed",
      });
      expect(await meta(sqlite, "off", "shots/off.png")).toMatchObject({
        "ai.classifier": "failed",
      });
      const goneAt = sqlite.db
        .prepare(
          `SELECT updated_at FROM file_metadata
           WHERE workspace = 'acme' AND object_key = 'shots/gone.png' AND meta_key = 'ai.classifier'`,
        )
        .get() as { updated_at: string };
      expect(goneAt.updated_at).not.toBe("2020-01-01T00:00:00.000Z");
    } finally {
      sqlite.close();
    }
  });

  it("leaves a file failed when the provider errors again", async () => {
    const acme = wsRecord("acme");
    const { sqlite, env } = harness({ acme }, (_body, call) => (call === 1 ? 500 : DECIDED));
    try {
      await putPng(env, acme, "shots/old.png");
      await putPng(env, acme, "shots/new.png");
      seed(sqlite, "acme", "shots/old.png", "failed", "2020-01-01T00:00:00.000Z");
      seed(sqlite, "acme", "shots/new.png", "failed", "2020-01-02T00:00:00.000Z");

      const result = await runClassifierRetrySweep(env);

      expect(result.errors).toEqual([]);
      expect(result.attempted).toBe(2);
      expect(result.resolved).toBe(1);
      expect(await meta(sqlite, "acme", "shots/old.png")).toMatchObject({
        "ai.classifier": "failed",
        "ai.error": "provider_error",
      });
      expect(await meta(sqlite, "acme", "shots/new.png")).toMatchObject({
        "ai.classifier": CLASSIFIER_VERSION,
      });
    } finally {
      sqlite.close();
    }
  });
});

describe("scheduled handler — classifier retry", () => {
  it("retries a failed file on the daily cron", async () => {
    const acme = wsRecord("acme");
    const { sqlite, env } = harness({ acme });
    try {
      await putPng(env, acme, "shots/a.png");
      seed(sqlite, "acme", "shots/a.png", "failed", "2020-01-01T00:00:00.000Z");
      const { ctx, settle } = fakeExecutionContext();

      await worker.scheduled({ cron: "0 6 * * *" } as ScheduledController, env, ctx);
      await settle();

      expect(await meta(sqlite, "acme", "shots/a.png")).toMatchObject({
        "ai.classifier": CLASSIFIER_VERSION,
      });
    } finally {
      sqlite.close();
    }
  });

  it("does not retry from the Monday digest cron", async () => {
    const acme = wsRecord("acme");
    const { sqlite, env, calls } = harness({ acme });
    try {
      await putPng(env, acme, "shots/a.png");
      seed(sqlite, "acme", "shots/a.png", "failed", "2020-01-01T00:00:00.000Z");
      const { ctx, settle } = fakeExecutionContext();

      await worker.scheduled({ cron: WEEKLY_DIGEST_CRON } as ScheduledController, env, ctx);
      await settle();

      expect(calls).toHaveLength(0);
      expect(await meta(sqlite, "acme", "shots/a.png")).toMatchObject({
        "ai.classifier": "failed",
      });
    } finally {
      sqlite.close();
    }
  });
});
