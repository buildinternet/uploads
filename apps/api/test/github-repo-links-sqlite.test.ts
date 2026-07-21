/// <reference types="node" />

import { describe, expect, it } from "vitest";
import {
  deleteRepoLink,
  deleteRepoLinkForWorkspace,
  findRepoLink,
  listRepoLinksForWorkspace,
  recordRepoLink,
  setRepoLink,
} from "../src/github-repo-links";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATION = "migrations/20260720120000_github_repo_links.sql";

describe("github repo links persistence against SQLite", () => {
  it("returns null for an unclaimed repo", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      await expect(findRepoLink(database(sqlite), "acme/web")).resolves.toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("records a claim and lowercases the repo key", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      await recordRepoLink(database(sqlite), "Acme/Web", "acme", "comment", 42);
      const link = await findRepoLink(database(sqlite), "acme/web");
      expect(link).toMatchObject({
        repo: "acme/web",
        workspaceName: "acme",
        installationId: 42,
        source: "comment",
      });
      expect(typeof link?.createdAt).toBe("string");
    } finally {
      sqlite.close();
    }
  });

  it("first claim wins: a later call from a different workspace is ignored", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      await recordRepoLink(database(sqlite), "acme/web", "acme", "comment");
      await recordRepoLink(database(sqlite), "acme/web", "someone-else", "promote");
      const link = await findRepoLink(database(sqlite), "acme/web");
      expect(link?.workspaceName).toBe("acme");
      expect(link?.source).toBe("comment");
    } finally {
      sqlite.close();
    }
  });

  it("a later call from the SAME workspace is also a no-op (row unchanged)", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      await recordRepoLink(database(sqlite), "acme/web", "acme", "comment", 1);
      await recordRepoLink(database(sqlite), "acme/web", "acme", "promote", 2);
      const link = await findRepoLink(database(sqlite), "acme/web");
      expect(link?.source).toBe("comment");
      expect(link?.installationId).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("deletes a link", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      await recordRepoLink(database(sqlite), "acme/web", "acme", "comment");
      await deleteRepoLink(database(sqlite), "acme/web");
      await expect(findRepoLink(database(sqlite), "acme/web")).resolves.toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("deleting a non-existent link is a harmless no-op", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      await expect(deleteRepoLink(database(sqlite), "acme/nope")).resolves.toBeUndefined();
    } finally {
      sqlite.close();
    }
  });
});

describe("deleteRepoLinkForWorkspace (self-serve unlink, issue #318)", () => {
  it("deletes when the caller owns the binding", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      await recordRepoLink(database(sqlite), "acme/web", "acme", "comment");
      await expect(deleteRepoLinkForWorkspace(database(sqlite), "acme/web", "acme")).resolves.toBe(
        true,
      );
      await expect(findRepoLink(database(sqlite), "acme/web")).resolves.toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("refuses (no-op) when the caller does not own the binding", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      await recordRepoLink(database(sqlite), "acme/web", "acme", "comment");
      await expect(
        deleteRepoLinkForWorkspace(database(sqlite), "acme/web", "someone-else"),
      ).resolves.toBe(false);
      const link = await findRepoLink(database(sqlite), "acme/web");
      expect(link?.workspaceName).toBe("acme");
    } finally {
      sqlite.close();
    }
  });

  it("is a harmless no-op on an unclaimed repo", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      await expect(deleteRepoLinkForWorkspace(database(sqlite), "acme/nope", "acme")).resolves.toBe(
        false,
      );
    } finally {
      sqlite.close();
    }
  });
});

describe("listRepoLinksForWorkspace (admin visibility, issue #318)", () => {
  it("returns only the calling workspace's bindings, newest first", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      // Distinct explicit timestamps (not insertion order) so the assertion
      // below actually exercises `ORDER BY created_at DESC` rather than
      // passing regardless of ordering (CodeRabbit, issue #318).
      await recordRepoLink(
        database(sqlite),
        "acme/web",
        "acme",
        "comment",
        null,
        new Date("2026-01-01T00:00:00.000Z"),
      );
      await recordRepoLink(
        database(sqlite),
        "acme/api",
        "acme",
        "cli",
        null,
        new Date("2026-02-01T00:00:00.000Z"),
      );
      await recordRepoLink(
        database(sqlite),
        "other/repo",
        "someone-else",
        "comment",
        null,
        new Date("2026-03-01T00:00:00.000Z"),
      );
      const links = await listRepoLinksForWorkspace(database(sqlite), "acme");
      // Newest (acme/api, Feb) first, oldest (acme/web, Jan) last —
      // "someone-else"'s later (Mar) binding is excluded entirely.
      expect(links.map((l) => l.repo)).toEqual(["acme/api", "acme/web"]);
      expect(links.every((l) => l.workspaceName === "acme")).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it("returns an empty list for a workspace with no bindings", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      await expect(listRepoLinksForWorkspace(database(sqlite), "acme")).resolves.toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});

describe("setRepoLink (operator override, issue #318)", () => {
  it("creates a binding for an unclaimed repo", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      await setRepoLink(database(sqlite), "acme/web", "acme", "admin");
      const link = await findRepoLink(database(sqlite), "acme/web");
      expect(link).toMatchObject({ workspaceName: "acme", source: "admin" });
    } finally {
      sqlite.close();
    }
  });

  it("reassigns an existing binding, overwriting the prior owner", async () => {
    const sqlite = new SqliteD1(MIGRATION);
    try {
      await recordRepoLink(database(sqlite), "acme/web", "acme", "comment");
      await setRepoLink(database(sqlite), "acme/web", "someone-else", "admin", 7);
      const link = await findRepoLink(database(sqlite), "acme/web");
      expect(link).toMatchObject({
        workspaceName: "someone-else",
        source: "admin",
        installationId: 7,
      });
    } finally {
      sqlite.close();
    }
  });
});
