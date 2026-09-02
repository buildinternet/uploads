/**
 * The in-memory `github_attachments` fake (helpers/fake-attachment-index-table.ts)
 * must recognize every statement github-attachment-index.ts actually issues.
 * Both sides read the SQL from one exported source (`ATTACHMENT_INDEX_SQL`),
 * so this test fails the moment a statement is reworded on one side only —
 * rather than the fake silently dropping writes.
 */
import { describe, expect, it } from "vitest";
import { ATTACHMENT_INDEX_SQL } from "../src/github-attachment-index";
import { AttachmentIndexTable } from "./helpers/fake-attachment-index-table";

const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();

const NOW = "2026-09-02T00:00:00.000Z";
const UPSERT_ARGS = ["acme", "acme/web", "pull", 12, "k.png", null, null, "put", NOW, NOW];

describe("fake github_attachments table ↔ ATTACHMENT_INDEX_SQL", () => {
  it("matches every write statement the module issues", () => {
    const table = new AttachmentIndexTable();
    const cases: [string, unknown[]][] = [
      [ATTACHMENT_INDEX_SQL.upsert, UPSERT_ARGS],
      [ATTACHMENT_INDEX_SQL.detach, [NOW, NOW, "acme", "k.png"]],
      [ATTACHMENT_INDEX_SQL.reattach, [NOW, "acme", "k.png"]],
      [ATTACHMENT_INDEX_SQL.rekey, ["k2.png", null, null, NOW, "acme", "k.png"]],
      [ATTACHMENT_INDEX_SQL.deleteOne, ["acme", "k.png"]],
      [ATTACHMENT_INDEX_SQL.deleteForKeys("?"), ["acme", "k.png"]],
      [ATTACHMENT_INDEX_SQL.deleteForWorkspace, ["acme"]],
    ];
    for (const [sql, args] of cases) {
      expect(table.tryRun(normalize(sql), args), sql).toBeDefined();
    }
  });

  it("matches the single-row read the module issues", () => {
    const table = new AttachmentIndexTable();
    table.tryRun(normalize(ATTACHMENT_INDEX_SQL.upsert), UPSERT_ARGS);
    expect(
      table.tryFirst(normalize(ATTACHMENT_INDEX_SQL.selectOne), ["acme", "k.png"]),
    ).toMatchObject({ object_key: "k.png" });
  });
});
