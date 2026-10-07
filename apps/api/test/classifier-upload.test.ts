import { describe, expect, it } from "vitest";
import { putObject } from "../src/files-core";
import { getMetadataForKeys } from "../src/file-metadata";
import {
  CLASSIFIER_LUNA_MODEL,
  CLASSIFIER_LUNA_VERSION,
  CLASSIFIER_MAX_IMAGE_BYTES,
  classifyAndStore,
} from "../src/classifier";
import { makePosterEnv, PNG, WORKSPACE } from "./poster-fixtures";
import type { WorkspaceRecord } from "../src/workspace";

/** Stage 1's reply: free text only — the enums come from stage 2. */
const DESCRIBED = {
  response:
    '{"description":"A settings page.","tags":["ui","settings"],"summary":"A settings page"}',
};

function jevAnswer(choice: string, confidence = 0.9) {
  return { type: "choice", choice, confidence, probabilities: { [choice]: confidence } };
}

/** Stage 2's reply: confident answers for all three closed enums. */
const DECIDED = {
  model: "jev-1.13.0",
  answers: {
    kind: jevAnswer("screenshot"),
    surface: jevAnswer("desktop"),
    screen: jevAnswer("settings"),
  },
  usage: {},
};

/** The default fake answers per stage, keyed off the model name. */
function defaultRun(model: string): unknown {
  return model === "typesafe/jev" ? DECIDED : DESCRIBED;
}

function makeClassifierEnv(
  run: (model: string) => Promise<unknown> | unknown = async (model) => defaultRun(model),
  wsOver: Partial<WorkspaceRecord> = {},
  opts: { lunaFlag?: boolean; provider?: string; openRouterKey?: string } = {},
) {
  const { env, db, ws } = makePosterEnv();
  const calls: unknown[] = [];
  const flagCalls: unknown[] = [];
  const patched = {
    ...env,
    AI: {
      run: async (...args: unknown[]) => {
        calls.push(args);
        return run(args[0] as string);
      },
    },
    FLAGS: {
      getBooleanValue: async (...args: unknown[]) => {
        flagCalls.push(args);
        if (args[0] === "llm-file-classifier") return true;
        if (args[0] === "llm-file-classifier-luna") return opts.lunaFlag === true;
        return false;
      },
    },
    AI_GATEWAY_ID: "uploads-classifier",
    CLASSIFIER_PROVIDER: opts.provider,
    OPENROUTER_API_KEY: opts.openRouterKey,
  } as unknown as Env;
  const workspace: WorkspaceRecord = { ...ws, name: WORKSPACE, ...wsOver };
  return { env: patched, db, ws: workspace, calls, flagCalls };
}

function withLunaGateway(base: ReturnType<typeof makeClassifierEnv>, status = 200) {
  const gatewayCalls: Array<{
    id: string;
    data: {
      provider: string;
      endpoint: string;
      headers: { Authorization: string };
      query: { model: string; state: Record<string, unknown> };
    };
    options: { gateway?: { skipCache?: boolean } };
  }> = [];
  const ai = base.env.AI as unknown as {
    gateway: (id: string) => { run: (data: unknown, options: unknown) => Promise<Response> };
  };
  ai.gateway = (id: string) => ({
    run: async (data: unknown, options: unknown) => {
      gatewayCalls.push({ id, data, options } as (typeof gatewayCalls)[number]);
      return new Response(JSON.stringify(DECIDED), { status });
    },
  });
  return { ...base, gatewayCalls };
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
    expect(meta?.["ai.classifier"]).toBe("v3");
    expect(meta?.["ai.tags"]).toBe("ui,settings");
    expect(meta?.["ai.summary"]).toBe("A settings page");
    expect(meta?.["ai.kind"]).toBe("screenshot");
    expect(meta?.["ai.surface"]).toBe("desktop");
    expect(meta?.["ai.screen"]).toBe("settings");
    // Two stages: describe, then decide.
    expect(calls).toHaveLength(2);
    const models = calls.map((c) => (c as [string])[0]);
    expect(models).toEqual(["@cf/meta/llama-3.2-11b-vision-instruct", "typesafe/jev"]);
    for (const call of calls) {
      const [, , options] = call as [string, unknown, { gateway?: { id?: string } }];
      expect(options.gateway?.id).toBe("uploads-classifier");
    }
    const [, decideInput] = calls[1] as [string, { state?: Record<string, unknown> }];
    expect(decideInput.state?.filename).toBe("pic.png");
    expect(decideInput.state?.description).toBe("A settings page.");
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
    expect(flagCalls).toContainEqual([
      "llm-file-classifier-luna",
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
    const { env, ws } = makeClassifierEnv(() => {
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
    const { env, ws, calls } = makeClassifierEnv(async (model) => defaultRun(model), {
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
    const { env, ws, calls } = makeClassifierEnv(async (model) => defaultRun(model), {
      llmClassifierEnabled: undefined,
    });
    const pending: Promise<unknown>[] = [];
    await putObject(env, ws, "images/pic.png", PNG, WORKSPACE, {
      waitUntil: (p) => pending.push(p),
    });
    await Promise.all(pending);
    expect(calls).toHaveLength(2);
  });

  it("skips when waitUntil is omitted (does not block putObject)", async () => {
    const { env, ws, calls } = makeClassifierEnv();
    await putObject(env, ws, "images/pic.png", PNG, WORKSPACE);
    expect(calls).toHaveLength(0);
  });
});

describe("classifyAndStore", () => {
  it("writes the enums from stage 2 even when stage 1 fails", async () => {
    const { env, ws } = makeClassifierEnv((model) => {
      if (model === "typesafe/jev") return DECIDED;
      throw new Error("vision down");
    });
    const written = await classifyAndStore(env, ws, WORKSPACE, "images/pic.png", PNG, "image/png");
    expect(written).toEqual({
      "ai.classifier": "v3",
      "ai.kind": "screenshot",
      "ai.surface": "desktop",
      "ai.screen": "settings",
    });
    const metaByKey = await getMetadataForKeys(env.DB, WORKSPACE, ["images/pic.png"]);
    expect(metaByKey.get("images/pic.png")?.["ai.tags"]).toBeUndefined();
  });

  it("drops an enum whose confidence is under the threshold", async () => {
    const { env, ws } = makeClassifierEnv((model) =>
      model === "typesafe/jev"
        ? { answers: { kind: jevAnswer("photo", 0.95), screen: jevAnswer("checkout", 0.2) } }
        : DESCRIBED,
    );
    const written = await classifyAndStore(env, ws, WORKSPACE, "images/pic.png", PNG, "image/png");
    expect(written?.["ai.kind"]).toBe("photo");
    expect(written?.["ai.screen"]).toBeUndefined();
  });

  it("sends no vision call for a text file and writes no tags or summary", async () => {
    const { env, ws, calls } = makeClassifierEnv((model) =>
      model === "typesafe/jev" ? DECIDED : DESCRIBED,
    );
    const bytes = new TextEncoder().encode("hello world\n");
    const written = await classifyAndStore(env, ws, WORKSPACE, "notes.txt", bytes, "text/plain");
    expect(calls).toHaveLength(1);
    expect((calls[0] as [string])[0]).toBe("typesafe/jev");
    expect(written?.["ai.tags"]).toBeUndefined();
    expect(written?.["ai.summary"]).toBeUndefined();
    expect(written?.["ai.kind"]).toBe("screenshot");
  });

  it("writes nothing when the decision model returns unusable output", async () => {
    const { env, ws } = makeClassifierEnv(() => ({ response: "nope" }));
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

  it("pins the jev hybrid when CLASSIFIER_PROVIDER=jev even if the luna flag is on", async () => {
    const { env, ws, calls } = makeClassifierEnv(
      async (model) => defaultRun(model),
      {},
      {
        provider: "jev",
        lunaFlag: true,
        openRouterKey: "test-key",
      },
    );
    const written = await classifyAndStore(env, ws, WORKSPACE, "images/pic.png", PNG, "image/png");
    expect(written?.["ai.classifier"]).toBe("v3");
    expect(written?.["ai.tags"]).toBe("ui,settings");
    expect(calls.map((c) => (c as [string])[0])).toEqual([
      "@cf/meta/llama-3.2-11b-vision-instruct",
      "typesafe/jev",
    ]);
  });
});

describe("luna decisions provider", () => {
  function lunaBase(opts: { viaFlag?: boolean; openRouterKey?: string } = {}) {
    return makeClassifierEnv(
      async () => {
        throw new Error("workers ai should not run");
      },
      {},
      {
        provider: opts.viaFlag ? undefined : "luna",
        lunaFlag: opts.viaFlag === true,
        openRouterKey: opts.openRouterKey ?? "test-key",
      },
    );
  }

  it("classifies an image in one call and skips llama vision", async () => {
    const { env, ws, calls, gatewayCalls } = withLunaGateway(lunaBase());
    const pending: Promise<unknown>[] = [];
    const result = await putObject(env, ws, "images/pic.png", PNG, WORKSPACE, {
      waitUntil: (p) => pending.push(p),
    });
    await Promise.all(pending);
    expect(calls).toHaveLength(0);
    expect(gatewayCalls).toHaveLength(1);
    const call = gatewayCalls[0]!;
    expect(call.id).toBe("uploads-classifier");
    expect(call.data.provider).toBe("openrouter");
    expect(call.data.endpoint).toBe("alpha/decisions");
    expect(call.data.headers.Authorization).toBe("Bearer test-key");
    expect(call.data.query.model).toBe(CLASSIFIER_LUNA_MODEL);
    expect(call.options.gateway?.skipCache).toBe(true);
    const state = call.data.query.state;
    expect(state.filename).toBe("pic.png");
    expect(state.content_type).toBe("image/png");
    expect(state.byte_size).toBe(PNG.byteLength);
    expect(state.description).toBeUndefined();
    const image = state.image as { type?: string; image_url?: string } | undefined;
    expect(image?.type).toBe("input_image");
    expect(image?.image_url?.startsWith("data:image/png;base64,")).toBe(true);

    const metaByKey = await getMetadataForKeys(env.DB, WORKSPACE, [result.key]);
    const meta = metaByKey.get(result.key);
    expect(meta?.["ai.classifier"]).toBe(CLASSIFIER_LUNA_VERSION);
    expect(meta?.["ai.kind"]).toBe("screenshot");
    expect(meta?.["ai.surface"]).toBe("desktop");
    expect(meta?.["ai.screen"]).toBe("settings");
    expect(meta?.["ai.tags"]).toBeUndefined();
    expect(meta?.["ai.summary"]).toBeUndefined();
  });

  it("classifies a text file from the excerpt and sends no image", async () => {
    const { env, ws, gatewayCalls } = withLunaGateway(lunaBase());
    const bytes = new TextEncoder().encode("export const n = 1;\n");
    const written = await classifyAndStore(env, ws, WORKSPACE, "src/n.ts", bytes, "text/plain");
    expect(gatewayCalls).toHaveLength(1);
    const state = gatewayCalls[0]!.data.query.state;
    expect(state.image).toBeUndefined();
    expect(state.excerpt).toContain("export const n");
    expect(written?.["ai.classifier"]).toBe(CLASSIFIER_LUNA_VERSION);
    expect(written?.["ai.kind"]).toBe("screenshot");
    expect(written?.["ai.tags"]).toBeUndefined();
    expect(written?.["ai.summary"]).toBeUndefined();
  });

  it("does not attach an oversized image", async () => {
    const { env, ws, gatewayCalls } = withLunaGateway(lunaBase());
    const big = new Uint8Array(CLASSIFIER_MAX_IMAGE_BYTES + 1);
    const written = await classifyAndStore(env, ws, WORKSPACE, "huge.png", big, "image/png");
    const state = gatewayCalls[0]!.data.query.state;
    expect(state.image).toBeUndefined();
    expect(state.note).toContain("image skipped");
    expect(written?.["ai.classifier"]).toBe(CLASSIFIER_LUNA_VERSION);
  });

  it("selects luna from the flag when CLASSIFIER_PROVIDER is unset", async () => {
    const { env, ws, calls, gatewayCalls } = withLunaGateway(lunaBase({ viaFlag: true }));
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "notes.txt",
      new TextEncoder().encode("hi\n"),
      "text/plain",
    );
    expect(calls).toHaveLength(0);
    expect(gatewayCalls).toHaveLength(1);
    expect(written?.["ai.classifier"]).toBe("v4");
  });

  it("writes nothing when the OpenRouter key is missing", async () => {
    const { env, ws, calls } = lunaBase({ openRouterKey: "  " });
    const written = await classifyAndStore(env, ws, WORKSPACE, "images/pic.png", PNG, "image/png");
    expect(written).toBeUndefined();
    expect(calls).toHaveLength(0);
    const metaByKey = await getMetadataForKeys(env.DB, WORKSPACE, ["images/pic.png"]);
    expect(metaByKey.get("images/pic.png")?.["ai.classifier"]).toBeUndefined();
  });

  it("fails open when OpenRouter returns an error", async () => {
    const { env, ws } = withLunaGateway(lunaBase(), 502);
    const written = await classifyAndStore(env, ws, WORKSPACE, "images/pic.png", PNG, "image/png");
    expect(written).toBeUndefined();
  });
});
