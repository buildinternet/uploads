import { describe, expect, it } from "vitest";
import { recordContentHash } from "../src/content-hash";
import {
  appendClassificationEvent,
  appendOverrideEvent,
  deleteFileEvents,
  listFileEvents,
} from "../src/file-events";
import { getFileMetadata, setFileMetadata, setServerFileMetadata } from "../src/file-metadata";
import { contentSha256Hex } from "../src/provenance";
import { approveUpload, holdAgain } from "../src/upload-hold-service";
import { effectiveHold } from "../src/upload-hold-read";
import type { WorkspaceRecord } from "../src/workspace";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATIONS = [
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20260724140000_file_content_hash.sql",
  "migrations/20261028120000_file_events.sql",
];

const ws: WorkspaceRecord = {
  provider: "r2",
  bucket: "uploads-default",
  binding: "UPLOADS_DEFAULT",
  prefix: "acme/",
  publicBaseUrl: "https://storage.uploads.sh",
};

function makeDb() {
  const sqlite = new SqliteD1(MIGRATIONS);
  const db = database(sqlite);
  const env = { DB: db } as Env;
  return { sqlite, db, env };
}

describe("file_events", () => {
  it("refuses a client set or delete of a safety flag", async () => {
    const { sqlite, db } = makeDb();
    await setServerFileMetadata(db, "acme", "a.png", { "ai.secret": "api_key" });
    await expect(setFileMetadata(db, "acme", "a.png", { "ai.secret": "none" })).rejects.toThrow(
      /reserved metadata key: ai\.secret/,
    );
    await expect(setFileMetadata(db, "acme", "a.png", {}, ["ai.secret"])).rejects.toThrow(
      /reserved metadata key: ai\.secret/,
    );
    expect((await getFileMetadata(db, "acme", "a.png"))["ai.secret"]).toBe("api_key");
    sqlite.close();
  });

  it("records a release override and leaves the safety flags", async () => {
    const { sqlite, db, env } = makeDb();
    await setServerFileMetadata(db, "acme", "shots/a.png", {
      "ai.hold": "pending",
      "ai.secret": "api_key",
      "ai.secret.confidence": "high",
      "ai.pii": "financial",
      "ai.rating": "explicit",
      "ai.content": "sexual",
    });
    await recordContentHash(db, "acme", "shots/a.png", "ab".repeat(32));
    expect(await approveUpload(env, ws, "acme", "shots/a.png", "Member")).toEqual({
      approved: true,
    });

    const stored = await getFileMetadata(db, "acme", "shots/a.png");
    expect(stored["ai.secret"]).toBe("api_key");
    expect(stored["ai.pii"]).toBe("financial");
    expect(stored["ai.rating"]).toBe("explicit");
    expect(stored["ai.content"]).toBe("sexual");
    expect(stored["ai.hold"]).toBe("approved");

    const events = await listFileEvents(db, "acme", "shots/a.png");
    expect(events).toMatchObject([
      {
        kind: "override",
        action: "release",
        actor: "Member",
        secret: "api_key",
        secretConfidence: "high",
        pii: "financial",
        rating: "explicit",
        contentFlag: "sexual",
        contentSha256: "ab".repeat(32),
      },
    ]);
    const view = await effectiveHold(env, "acme", "shots/a.png", stored);
    expect(view).toEqual({ hold: "approved", by: "Member", at: stored["ai.hold.at"] });

    expect(await holdAgain(env, ws, "acme", "shots/a.png", "Member")).toEqual({ held: true });
    const after = await getFileMetadata(db, "acme", "shots/a.png");
    expect(after["ai.hold"]).toBe("pending");
    expect(after["ai.secret"]).toBe("api_key");
    expect((await listFileEvents(db, "acme", "shots/a.png")).map((event) => event.action)).toEqual([
      "release",
      "hold",
    ]);
    sqlite.close();
  });

  it("keeps earlier events, and ignores an override once the hash changes", async () => {
    const { sqlite, db, env } = makeDb();
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5, 6]);
    await appendClassificationEvent(env, {
      workspace: "acme",
      objectKey: "a.png",
      bytes: first,
      kind: "classified",
      classifierVersion: "v5",
      model: "jev",
      safety: { "ai.secret": "api_key", "ai.secret.confidence": "high" },
    });
    await appendClassificationEvent(env, {
      workspace: "acme",
      objectKey: "a.png",
      bytes: second,
      kind: "failed",
      classifierVersion: "failed",
      model: "jev",
      reason: "provider_error",
    });
    const events = await listFileEvents(db, "acme", "a.png");
    expect(events.map((event) => event.kind)).toEqual(["classified", "failed"]);
    expect(events[0]).toMatchObject({
      secret: "api_key",
      contentSha256: await contentSha256Hex(first),
    });
    expect(events[1]?.contentSha256).toBe(await contentSha256Hex(second));
    expect(events[0]?.contentSha256).not.toBe(events[1]?.contentSha256);

    await setServerFileMetadata(db, "acme", "a.png", {
      "ai.hold": "approved",
      "ai.hold.by": "Row",
      "ai.hold.at": "2026-01-01T00:00:00.000Z",
    });
    await recordContentHash(db, "acme", "a.png", "aa".repeat(32));
    await appendOverrideEvent(env, {
      workspace: "acme",
      objectKey: "a.png",
      action: "release",
      actor: "Event",
      at: "2026-02-01T00:00:00.000Z",
    });
    const matched = await getFileMetadata(db, "acme", "a.png");
    expect(await effectiveHold(env, "acme", "a.png", matched)).toMatchObject({
      hold: "approved",
      by: "Event",
    });
    await recordContentHash(db, "acme", "a.png", "bb".repeat(32));
    expect(await effectiveHold(env, "acme", "a.png", matched)).toMatchObject({
      hold: "approved",
      by: "Row",
    });

    await deleteFileEvents(db, "acme", "a.png");
    expect(await listFileEvents(db, "acme", "a.png")).toEqual([]);
    sqlite.close();
  });
});
