import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { deriveCookieDomain, isCliSessionUserAgent, upsertGithubLogin } from "./auth";
import * as schema from "./schema";
import { createFakeD1 } from "./test/fake-d1";

describe("isCliSessionUserAgent", () => {
  it("matches the uploads CLI device-flow User-Agent", () => {
    expect(isCliSessionUserAgent("@buildinternet/uploads/1.2.3 (device-token)")).toBe(true);
    expect(isCliSessionUserAgent("@buildinternet/uploads")).toBe(true);
  });

  it("rejects browsers and empty values", () => {
    expect(isCliSessionUserAgent("Mozilla/5.0 (Macintosh) Chrome/120")).toBe(false);
    expect(isCliSessionUserAgent(null)).toBe(false);
    expect(isCliSessionUserAgent(undefined)).toBe(false);
  });
});

describe("deriveCookieDomain", () => {
  it("shares the whole apex host for a 2-label domain (no public-suffix leak)", () => {
    expect(deriveCookieDomain("https://uploads.sh")).toBe(".uploads.sh");
  });

  it("strips the first label for a 3+-label host", () => {
    expect(deriveCookieDomain("https://auth.uploads.sh")).toBe(".uploads.sh");
    expect(deriveCookieDomain("https://api.auth.uploads.sh")).toBe(".auth.uploads.sh");
  });

  it("returns undefined for localhost", () => {
    expect(deriveCookieDomain("http://localhost:8788")).toBeUndefined();
  });

  it("returns undefined for a bare *.localhost host (no shareable parent)", () => {
    expect(deriveCookieDomain("http://auth.localhost:8788")).toBeUndefined();
  });

  it("anchors the real-TLD portless zone parent across worktree prefixes", () => {
    expect(deriveCookieDomain("https://auth.uploads.local.buildinternet.dev")).toBe(
      ".uploads.local.buildinternet.dev",
    );
    expect(deriveCookieDomain("https://fix-ui.auth.uploads.local.buildinternet.dev")).toBe(
      ".uploads.local.buildinternet.dev",
    );
  });

  it("shares the last-two-label parent for portless *.localhost hosts", () => {
    expect(deriveCookieDomain("https://auth.uploads.localhost")).toBe(".uploads.localhost");
    expect(deriveCookieDomain("http://auth.uploads.localhost:1355")).toBe(".uploads.localhost");
    expect(deriveCookieDomain("https://fix-ui.auth.uploads.localhost")).toBe(".uploads.localhost");
  });

  it("returns undefined for an IP host", () => {
    expect(deriveCookieDomain("http://127.0.0.1:8788")).toBeUndefined();
  });

  it("returns undefined for an invalid URL", () => {
    expect(deriveCookieDomain("not-a-url")).toBeUndefined();
  });

  it("returns undefined when the URL is undefined", () => {
    expect(deriveCookieDomain(undefined)).toBeUndefined();
  });
});

// Issue #580: captured via the github socialProvider's mapProfileToUser hook
// (see src/auth.ts), which runs on every completed GitHub OAuth callback —
// this exercises just the upsert itself, not the wiring through Better Auth.
describe("upsertGithubLogin", () => {
  function orm() {
    return drizzle(createFakeD1(), { schema });
  }

  it("inserts a new row for a first-time link", async () => {
    const db = orm();
    await upsertGithubLogin(db, "123", "octocat");
    const rows = await db.select().from(schema.githubIdentity);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accountId: "123", login: "octocat" });
  });

  it("last-write-wins: a re-authentication with a renamed login overwrites the stored value", async () => {
    const db = orm();
    await upsertGithubLogin(db, "123", "octocat");
    await upsertGithubLogin(db, "123", "octocat-renamed");
    const rows = await db.select().from(schema.githubIdentity);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accountId: "123", login: "octocat-renamed" });
  });

  it("never throws — swallows a write failure (e.g. blank inputs are no-ops)", async () => {
    const db = orm();
    await expect(upsertGithubLogin(db, "", "octocat")).resolves.toBeUndefined();
    await expect(upsertGithubLogin(db, "123", "")).resolves.toBeUndefined();
    expect(await db.select().from(schema.githubIdentity)).toHaveLength(0);
  });
});
