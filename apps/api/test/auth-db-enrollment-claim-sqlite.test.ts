/**
 * Issue #869 phase B follow-up (review cleanup): `claimMemberEnrollment` /
 * `releaseEnrollmentClaim` were extracted out of `routes/auth.ts`'s join
 * handler into `auth-db.ts` — see that file's docblocks. Route-level
 * coverage for the full `/auth/enrollments/join` flow already lives in
 * `routes-auth-join.test.ts`; this file covers the two helpers directly,
 * sqlite-backed (real SQL, not the hand-rolled `FakeD1` in
 * `auth-db.test.ts`) so the `kind = 'member'` / `code_hash` scoping is
 * exercised for real.
 */
import { describe, expect, it } from "vitest";
import { claimMemberEnrollment, createEnrollment, releaseEnrollmentClaim } from "../src/auth-db";
import { database, SqliteD1 } from "./helpers/sqlite-d1";

const MIGRATIONS = [
  "migrations/20260710120000_auth.sql",
  "migrations/20260711120000_invite_pages.sql",
  "migrations/20260712230000_token_minting_user.sql",
  "migrations/20260817180000_token_last_used.sql",
  "migrations/20260827160000_auth_enrollments_kind.sql",
];

function db() {
  return database(new SqliteD1(MIGRATIONS)) as unknown as D1Database;
}

describe("claimMemberEnrollment", () => {
  it("claims a member-kind link and marks it used", async () => {
    const d1 = db();
    const link = await createEnrollment(d1, { workspace: "acme", scopes: [], kind: "member" });

    const claim = await claimMemberEnrollment(d1, link.code);
    expect(claim).toEqual({ id: link.id, workspace: "acme", codeHash: expect.any(String) });
  });

  it("is single-use: a second claim of the same code fails", async () => {
    const d1 = db();
    const link = await createEnrollment(d1, { workspace: "acme", scopes: [], kind: "member" });

    expect(await claimMemberEnrollment(d1, link.code)).not.toBeNull();
    expect(await claimMemberEnrollment(d1, link.code)).toBeNull();
  });

  it("rejects a token-kind code — never exchangeable for membership", async () => {
    const d1 = db();
    const link = await createEnrollment(d1, { workspace: "acme", scopes: ["files:read"] });
    expect(await claimMemberEnrollment(d1, link.code)).toBeNull();
  });

  it("rejects an expired member-kind code", async () => {
    const d1 = db();
    const past = new Date("2020-01-01T00:00:00.000Z");
    const link = await createEnrollment(d1, {
      workspace: "acme",
      scopes: [],
      kind: "member",
      enrollmentSeconds: 60,
      now: past,
    });
    expect(await claimMemberEnrollment(d1, link.code)).toBeNull();
  });

  it("rejects an unknown code", async () => {
    const d1 = db();
    expect(await claimMemberEnrollment(d1, `upe_${"a".repeat(24)}`)).toBeNull();
  });
});

describe("releaseEnrollmentClaim", () => {
  it("restores used_at so the link is claimable again", async () => {
    const d1 = db();
    const link = await createEnrollment(d1, { workspace: "acme", scopes: [], kind: "member" });

    const claim = await claimMemberEnrollment(d1, link.code);
    expect(claim).not.toBeNull();
    await releaseEnrollmentClaim(d1, claim!.id, claim!.codeHash);

    const reclaim = await claimMemberEnrollment(d1, link.code);
    expect(reclaim).toEqual(claim);
  });

  it("is scoped to (id, code_hash) — a mismatched hash restores nothing", async () => {
    const d1 = db();
    const link = await createEnrollment(d1, { workspace: "acme", scopes: [], kind: "member" });
    const claim = await claimMemberEnrollment(d1, link.code);
    expect(claim).not.toBeNull();

    await releaseEnrollmentClaim(d1, claim!.id, "not-the-real-hash");
    // Still claimed — the mismatched-hash release didn't touch the row.
    expect(await claimMemberEnrollment(d1, link.code)).toBeNull();
  });
});
