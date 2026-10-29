import { describe, expect, it } from "vitest";
import { listObjects, putObject, setObjectVisibility } from "../src/files-core";
import { storage } from "../src/storage";
import { objectVisibility } from "../src/visibility";
import type { WorkspaceRecord } from "../src/workspace";
import { makePosterEnv, PNG, WORKSPACE } from "./poster-fixtures";

describe("setObjectVisibility", () => {
  it("writes a hosted row and lists it without copying bytes", async () => {
    const { env, bucket, db, ws } = makePosterEnv();
    const named = { ...ws, name: WORKSPACE };
    const put = await putObject(env, named, "shots/a.png", PNG, WORKSPACE);
    const store = await storage(env, named);
    const before = bucket.store.get(`default/${put.key}`);

    await setObjectVisibility(env, named, WORKSPACE, store, put.key, "private", 1);

    const after = bucket.store.get(`default/${put.key}`);
    expect(after?.data).toEqual(before?.data);
    expect(after?.customMetadata).toEqual(before?.customMetadata);
    expect(db.fileMetadata.get(`${WORKSPACE} ${put.key}`)?.get("ai.visibility")).toBe("private");
    const page = await listObjects(
      { ...env, WEB_ORIGIN: "https://uploads.test" } as unknown as typeof env,
      named,
      {},
    );
    expect(page.items.find((item) => item.key === put.key)?.visibility).toBe("private");
  });

  it("still rewrites a bring-your-own object, and keeps the size cap there", async () => {
    const { env, db, ws } = makePosterEnv();
    const put = await putObject(env, ws, "shots/a.png", PNG, WORKSPACE);
    const store = await storage(env, ws);
    const byo = { provider: "s3", bucket: "customer" } as WorkspaceRecord;

    await expect(
      setObjectVisibility(env, byo, WORKSPACE, store, put.key, "private", 1),
    ).rejects.toMatchObject({ code: "file_too_large" });
    expect(objectVisibility((await store.head(put.key)).metadata)).toBeUndefined();

    await setObjectVisibility(env, byo, WORKSPACE, store, put.key, "private");
    expect(objectVisibility((await store.head(put.key)).metadata)).toBe("private");
    expect(db.fileMetadata.get(`${WORKSPACE} ${put.key}`)?.has("ai.visibility") ?? false).toBe(
      false,
    );
  });
});
