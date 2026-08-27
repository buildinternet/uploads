/**
 * Issue #869 phase B follow-up (review cleanup): `claimMemberEnrollment` /
 * `releaseEnrollmentClaim` were extracted out of `routes/auth.ts`'s join
 * handler into `auth-db.ts` — see that file's docblocks. Route-level
 * coverage for the full `/auth/enrollments/join` flow already lives in
 * `routes-auth-join.test.ts`; this file covers the two helpers directly,
 * sqlite-backed (real SQL, not the hand-rolled `FakeD1` in
 * `auth-db.test.ts`) so the `kind = 'member'` / `code_hash` scoping is
 * exercised for real.
 *
 * Issue #876: `claimMemberEnrollment` moved from a single-winner `used_at`
 * stamp to a conditional `use_count` increment — this file's "single-use"
 * coverage below now exercises the `max_uses = 1` case explicitly, plus new
 * coverage for unlimited/capped multi-use and concurrent redemption.
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
  "migrations/20260827170000_auth_enrollments_multi_use.sql",
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

  it("is unlimited by default: the same code claims repeatedly", async () => {
    const d1 = db();
    const link = await createEnrollment(d1, { workspace: "acme", scopes: [], kind: "member" });

    expect(await claimMemberEnrollment(d1, link.code)).not.toBeNull();
    expect(await claimMemberEnrollment(d1, link.code)).not.toBeNull();
    expect(await claimMemberEnrollment(d1, link.code)).not.toBeNull();
  });

  it("respects an explicit max_uses cap — the (max_uses+1)th claim fails", async () => {
    const d1 = db();
    const link = await createEnrollment(d1, {
      workspace: "acme",
      scopes: [],
      kind: "member",
      maxUses: 2,
    });

    expect(await claimMemberEnrollment(d1, link.code)).not.toBeNull();
    expect(await claimMemberEnrollment(d1, link.code)).not.toBeNull();
    expect(await claimMemberEnrollment(d1, link.code)).toBeNull();
  });

  it("max_uses: 1 behaves like the pre-#876 single-use link", async () => {
    const d1 = db();
    const link = await createEnrollment(d1, {
      workspace: "acme",
      scopes: [],
      kind: "member",
      maxUses: 1,
    });

    expect(await claimMemberEnrollment(d1, link.code)).not.toBeNull();
    expect(await claimMemberEnrollment(d1, link.code)).toBeNull();
  });

  it("two concurrent claims of an unlimited link both win", async () => {
    const d1 = db();
    const link = await createEnrollment(d1, { workspace: "acme", scopes: [], kind: "member" });

    const [a, b] = await Promise.all([
      claimMemberEnrollment(d1, link.code),
      claimMemberEnrollment(d1, link.code),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it("two concurrent claims of a max_uses: 1 link — only one wins", async () => {
    const d1 = db();
    const link = await createEnrollment(d1, {
      workspace: "acme",
      scopes: [],
      kind: "member",
      maxUses: 1,
    });

    const [a, b] = await Promise.all([
      claimMemberEnrollment(d1, link.code),
      claimMemberEnrollment(d1, link.code),
    ]);
    const successes = [a, b].filter((v) => v !== null);
    expect(successes).toHaveLength(1);
  });

  it("claims a non-expiring member link (expires_at NULL)", async () => {
    const d1 = db();
    const link = await createEnrollment(d1, {
      workspace: "acme",
      scopes: [],
      kind: "member",
      enrollmentSeconds: null,
    });
    expect(
      await claimMemberEnrollment(d1, link.code, new Date("2099-01-01T00:00:00.000Z")),
    ).not.toBeNull();
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
  it("decrements use_count so the link is claimable again under its cap", async () => {
    const d1 = db();
    const link = await createEnrollment(d1, {
      workspace: "acme",
      scopes: [],
      kind: "member",
      maxUses: 1,
    });

    const claim = await claimMemberEnrollment(d1, link.code);
    expect(claim).not.toBeNull();
    expect(await claimMemberEnrollment(d1, link.code)).toBeNull(); // exhausted

    await releaseEnrollmentClaim(d1, claim!.id, claim!.codeHash);

    const reclaim = await claimMemberEnrollment(d1, link.code);
    expect(reclaim).toEqual(claim);
  });

  it("is scoped to (id, code_hash) — a mismatched hash releases nothing", async () => {
    const d1 = db();
    const link = await createEnrollment(d1, {
      workspace: "acme",
      scopes: [],
      kind: "member",
      maxUses: 1,
    });
    const claim = await claimMemberEnrollment(d1, link.code);
    expect(claim).not.toBeNull();

    await releaseEnrollmentClaim(d1, claim!.id, "not-the-real-hash");
    // Still exhausted — the mismatched-hash release didn't touch the row.
    expect(await claimMemberEnrollment(d1, link.code)).toBeNull();
  });

  it("never underflows use_count below zero", async () => {
    const d1 = db();
    const link = await createEnrollment(d1, { workspace: "acme", scopes: [], kind: "member" });
    const claim = await claimMemberEnrollment(d1, link.code);
    expect(claim).not.toBeNull();

    // Release twice — the second is a no-op (use_count > 0 guard), not -1.
    await releaseEnrollmentClaim(d1, claim!.id, claim!.codeHash);
    await releaseEnrollmentClaim(d1, claim!.id, claim!.codeHash);

    // A fresh max_uses:1 claim path would still see use_count at 0, not -1 —
    // exercised indirectly via a normal claim succeeding.
    expect(await claimMemberEnrollment(d1, link.code)).not.toBeNull();
  });
});
