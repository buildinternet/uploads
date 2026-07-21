/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { deleteRepoLink, findRepoLink, recordRepoLink } from "../src/github-repo-links";
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
