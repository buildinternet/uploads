import { describe, expect, it } from "vitest";
import { putObject } from "../src/files-core";
import { getMetadataForKeys } from "../src/file-metadata";
import { classifyAndStore } from "../src/classifier";
import { makePosterEnv, PNG, WORKSPACE } from "./poster-fixtures";
import type { WorkspaceRecord } from "../src/workspace";

const CLASSIFIED = {
  response: '{"tags":["ui","settings"],"summary":"A settings page","kind":"screenshot"}',
};

function makeClassifierEnv(
  run: () => Promise<unknown> = async () => CLASSIFIED,
  wsOver: Partial<WorkspaceRecord> = {},
) {
  const { env, db, ws } = makePosterEnv();
  const calls: unknown[] = [];
  const flagCalls: unknown[] = [];
  const patched = {
    ...env,
    AI: {
      run: async (...args: unknown[]) => {
        calls.push(args);
        return run();
      },
    },
    FLAGS: {
      getBooleanValue: async (...args: unknown[]) => {
        flagCalls.push(args);
        return true;
      },
    },
    AI_GATEWAY_ID: "uploads-classifier",
  } as unknown as Env;
  const workspace: WorkspaceRecord = { ...ws, name: WORKSPACE, ...wsOver };
  return { env: patched, db, ws: workspace, calls, flagCalls };
}

describe("classifier on upload", () => {
  it("writes server-owned ai.* metadata after a successful put", async () => {
    const { env, ws, calls } = makeClassifierEnv();
    const pending: Promise<unknown>[] = [];
    const result = await putObject(env, ws, "images/pic.png", PNG, WORKSPACE, {
      waitUntil: (p) => pending.push(p),
    });
    await Promise.all(pending);
    const metaByKey = await getMetadataForKeys(env.DB, WORKSPACE, [result.key]);
    const meta = metaByKey.get(result.key);
    expect(meta?.["ai.classifier"]).toBe("v1");
    expect(meta?.["ai.tags"]).toBe("ui,settings");
    expect(meta?.["ai.summary"]).toBe("A settings page");
    expect(meta?.["ai.kind"]).toBe("screenshot");
    expect(calls).toHaveLength(1);
    const [, , options] = calls[0] as [string, unknown, { gateway?: { id?: string } }];
    expect(options.gateway?.id).toBe("uploads-classifier");
  });

  it("evaluates Flagship with org and workspace context", async () => {
    const { env, ws, flagCalls } = makeClassifierEnv();
    const pending: Promise<unknown>[] = [];
    await putObject(env, ws, "images/pic.png", PNG, WORKSPACE, {
      waitUntil: (p) => pending.push(p),
    });
    await Promise.all(pending);
    expect(flagCalls).toContainEqual([
      "llm-file-classifier",
      false,
      { org: WORKSPACE, workspace: WORKSPACE },
    ]);
  });

  it("leaves the request's own custom metadata intact", async () => {
    const { env, ws } = makeClassifierEnv();
    const pending: Promise<unknown>[] = [];
    const result = await putObject(env, ws, "images/pic.png", PNG, WORKSPACE, {
      metadata: { path: "/settings", state: "after" },
      waitUntil: (p) => pending.push(p),
    });
    await Promise.all(pending);
    const metaByKey = await getMetadataForKeys(env.DB, WORKSPACE, [result.key]);
    const meta = metaByKey.get(result.key);
    expect(meta?.path).toBe("/settings");
    expect(meta?.state).toBe("after");
    expect(meta?.["ai.tags"]).toBe("ui,settings");
  });

  it("does not fail the upload when the model throws", async () => {
    const { env, ws } = makeClassifierEnv(async () => {
      throw new Error("gateway down");
    });
    const pending: Promise<unknown>[] = [];
    const result = await putObject(env, ws, "images/pic.png", PNG, WORKSPACE, {
      waitUntil: (p) => pending.push(p),
    });
    expect(result.key).toBe("images/pic.png");
    expect(result.contentType).toBe("image/png");
    await Promise.all(pending);
    const metaByKey = await getMetadataForKeys(env.DB, WORKSPACE, [result.key]);
    expect(metaByKey.get(result.key)?.["ai.classifier"]).toBeUndefined();
  });

  it("skips when the workspace hard-off is set", async () => {
    const { env, ws, calls } = makeClassifierEnv(async () => CLASSIFIED, {
      llmClassifierEnabled: false,
    });
    const pending: Promise<unknown>[] = [];
    await putObject(env, ws, "images/pic.png", PNG, WORKSPACE, {
      waitUntil: (p) => pending.push(p),
    });
    await Promise.all(pending);
    expect(calls).toHaveLength(0);
  });

  it("classifies when llmClassifierEnabled is unset (Flagship is the allowlist)", async () => {
    const { env, ws, calls } = makeClassifierEnv(async () => CLASSIFIED, {
      llmClassifierEnabled: undefined,
    });
    const pending: Promise<unknown>[] = [];
    await putObject(env, ws, "images/pic.png", PNG, WORKSPACE, {
      waitUntil: (p) => pending.push(p),
    });
    await Promise.all(pending);
    expect(calls).toHaveLength(1);
  });

  it("skips when waitUntil is omitted (does not block putObject)", async () => {
    const { env, ws, calls } = makeClassifierEnv();
    await putObject(env, ws, "images/pic.png", PNG, WORKSPACE);
    expect(calls).toHaveLength(0);
  });
});

describe("classifyAndStore", () => {
  it("writes nothing when the model returns unusable text", async () => {
    const { env, ws } = makeClassifierEnv(async () => ({ response: "nope" }));
    const written = await classifyAndStore(env, ws, WORKSPACE, "images/pic.png", PNG, "image/png");
    expect(written).toBeUndefined();
    const metaByKey = await getMetadataForKeys(env.DB, WORKSPACE, ["images/pic.png"]);
    expect(metaByKey.get("images/pic.png")?.["ai.classifier"]).toBeUndefined();
  });

  it("does not call the model after a timeout", async () => {
    const { env, ws } = makeClassifierEnv(() => new Promise(() => {}));
    const started = Date.now();
    const written = await classifyAndStore(env, ws, WORKSPACE, "images/pic.png", PNG, "image/png", {
      timeoutMs: 20,
    });
    expect(written).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("swallows runner errors", async () => {
    const { env, ws } = makeClassifierEnv();
    const written = await classifyAndStore(env, ws, WORKSPACE, "images/pic.png", PNG, "image/png", {
      run: async () => {
        throw new Error("boom");
      },
    });
    expect(written).toBeUndefined();
  });
});
