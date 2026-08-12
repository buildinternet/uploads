/// <reference types="node" />

import { describe, expect, it } from "vitest";
import {
  generatePrefixId,
  getActivePrefixId,
  getOrMintPrefixId,
  listActivePrefixIds,
  PRIVATE_PREFIX_ID_RE,
  retirePrefixId,
} from "../src/github-private-prefixes";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const MIGRATIONS = ["migrations/20260811210000_github_private_prefixes.sql"];

describe("generatePrefixId / PRIVATE_PREFIX_ID_RE", () => {
  it("returns a 32-char lowercase hex id matching the regex", () => {
    const id = generatePrefixId();
    expect(id).toMatch(PRIVATE_PREFIX_ID_RE);
    expect(id).toHaveLength(32);
  });

  it("returns different ids on successive calls", () => {
    expect(generatePrefixId()).not.toBe(generatePrefixId());
  });
});

describe("github private prefixes persistence against SQLite", () => {
  it("mints a 32-hex id for a fresh (repo, branch)", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const id = await getOrMintPrefixId(database(sqlite), "Acme/Web", "main");
      expect(id).toMatch(PRIVATE_PREFIX_ID_RE);
    } finally {
      sqlite.close();
    }
  });

  it("is idempotent: a second mint call returns the same id", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const first = await getOrMintPrefixId(db, "acme/web", "main");
      const second = await getOrMintPrefixId(db, "acme/web", "main");
      expect(second).toBe(first);
    } finally {
      sqlite.close();
    }
  });

  it("distinct branches get distinct ids", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const main = await getOrMintPrefixId(db, "acme/web", "main");
      const feature = await getOrMintPrefixId(db, "acme/web", "feature-x");
      expect(main).not.toBe(feature);
    } finally {
      sqlite.close();
    }
  });

  it("the '' branch (repo-level sentinel) works", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const id = await getOrMintPrefixId(db, "acme/web", "");
      expect(id).toMatch(PRIVATE_PREFIX_ID_RE);
      await expect(getActivePrefixId(db, "acme/web", "")).resolves.toBe(id);
    } finally {
      sqlite.close();
    }
  });

  it("getActivePrefixId returns null when nothing has been minted", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      await expect(getActivePrefixId(database(sqlite), "acme/web", "main")).resolves.toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("lowercases repo and branch on the way in", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const id = await getOrMintPrefixId(db, "Acme/Web", "Main");
      await expect(getActivePrefixId(db, "acme/web", "main")).resolves.toBe(id);
      await expect(getActivePrefixId(db, "ACME/WEB", "MAIN")).resolves.toBe(id);
    } finally {
      sqlite.close();
    }
  });

  it("listActivePrefixIds returns ids across branches and excludes retired ones", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const main = await getOrMintPrefixId(db, "acme/web", "main");
      const feature = await getOrMintPrefixId(db, "acme/web", "feature-x");
      const repoLevel = await getOrMintPrefixId(db, "acme/web", "");
      await retirePrefixId(db, "acme/web", "feature-x", feature);

      const ids = await listActivePrefixIds(db, "acme/web");
      expect(new Set(ids)).toEqual(new Set([main, repoLevel]));
      expect(ids).not.toContain(feature);
    } finally {
      sqlite.close();
    }
  });

  it("retirePrefixId then getOrMintPrefixId mints a fresh, different id", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const original = await getOrMintPrefixId(db, "acme/web", "main");
      await retirePrefixId(db, "acme/web", "main", original);
      const rotated = await getOrMintPrefixId(db, "acme/web", "main");
      expect(rotated).not.toBe(original);
      expect(rotated).toMatch(PRIVATE_PREFIX_ID_RE);
    } finally {
      sqlite.close();
    }
  });

  it("the partial unique index enforces one active row per (repo, branch): two mints under contention converge on one id", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    try {
      const db = database(sqlite);
      const [a, b] = await Promise.all([
        getOrMintPrefixId(db, "acme/web", "main"),
        getOrMintPrefixId(db, "acme/web", "main"),
      ]);
      expect(a).toBe(b);
      const ids = await listActivePrefixIds(db, "acme/web");
      expect(ids).toEqual([a]);
    } finally {
      sqlite.close();
    }
  });
});
