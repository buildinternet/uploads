/**
 * Delete usage accounting — single-winner claim (issue #570).
 *
 * Unit coverage of claim/clear lives in usage.test.ts; these exercises wire
 * the claim through putObject/deleteObject end-to-end on the real helpers.
 */
import { describe, expect, it } from "vitest";
import { deleteObject, putObject } from "../src/files-core";
import { claimDeleteUsageSafe } from "../src/usage";
import { makePosterEnv, PNG, WORKSPACE } from "./poster-fixtures";

describe("deleteObject usage accounting (issue #570)", () => {
  it("debits the ledger once on a normal delete", async () => {
    const { env, db, ws } = makePosterEnv();
    const put = await putObject(env, ws, "screenshots/shot.png", PNG, WORKSPACE);
    expect(db.usage.get(WORKSPACE)).toMatchObject({
      bytes: PNG.byteLength,
      objects: 1,
    });

    await deleteObject(env, ws, put.key, WORKSPACE);
    expect(db.usage.get(WORKSPACE)).toMatchObject({ bytes: 0, objects: 0 });
  });

  it("skips metering when another concurrent delete already claimed the key", async () => {
    const { env, db, ws } = makePosterEnv();
    const put = await putObject(env, ws, "screenshots/shot.png", PNG, WORKSPACE);
    const afterPut = db.usage.get(WORKSPACE);
    expect(afterPut?.bytes).toBe(PNG.byteLength);

    // Sibling request already won the claim (and, in production, already
    // applied the negative delta). This request still removes the object but
    // must not debit again.
    expect(await claimDeleteUsageSafe(env.DB, WORKSPACE, put.key)).toBe(true);

    await deleteObject(env, ws, put.key, WORKSPACE);
    expect(db.usage.get(WORKSPACE)).toMatchObject({
      bytes: afterPut?.bytes,
      objects: afterPut?.objects,
    });
  });

  it("allows a re-uploaded key to debit again on a later delete", async () => {
    const { env, db, ws } = makePosterEnv();
    const first = await putObject(env, ws, "screenshots/shot.png", PNG, WORKSPACE);
    await deleteObject(env, ws, first.key, WORKSPACE);
    expect(db.usage.get(WORKSPACE)).toMatchObject({ bytes: 0, objects: 0 });

    // Same key again (overwrite path with replace) — clearDeleteUsageClaimSafe
    // must have dropped the prior claim so this lifecycle can meter.
    const second = await putObject(env, ws, first.key, PNG, WORKSPACE, { replace: true });
    expect(second.key).toBe(first.key);
    expect(db.usage.get(WORKSPACE)).toMatchObject({
      bytes: PNG.byteLength,
      objects: 1,
    });

    await deleteObject(env, ws, second.key, WORKSPACE);
    expect(db.usage.get(WORKSPACE)).toMatchObject({ bytes: 0, objects: 0 });
  });
});
