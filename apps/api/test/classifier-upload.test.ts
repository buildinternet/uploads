import { afterEach, describe, expect, it, vi } from "vitest";
import { putObject } from "../src/files-core";
import { getMetadataForKeys } from "../src/file-metadata";
import {
  CLASSIFIER_JEV_MODEL,
  CLASSIFIER_LUNA_MODEL,
  CLASSIFIER_LUNA_VERSION,
  CLASSIFIER_MAX_IMAGE_BYTES,
  CLASSIFIER_VERSION,
  OPENROUTER_DECISIONS_URL,
  classifyAndStore,
} from "../src/classifier";
import { makePosterEnv, PNG, WORKSPACE } from "./poster-fixtures";
import type { WorkspaceRecord } from "../src/workspace";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jevAnswer(choice: string, confidence = 0.9) {
  return { type: "choice", choice, confidence, probabilities: { [choice]: confidence } };
}

const DECIDED = {
  model: "~typesafe/jev-latest",
  answers: {
    kind: jevAnswer("screenshot"),
    surface: jevAnswer("desktop"),
    screen: jevAnswer("settings"),
  },
  usage: {},
};

function pngOf(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return bytes;
}

interface DecisionCall {
  url: string;
  headers: Record<string, string>;
  body: {
    model: string;
    state: unknown[];
    questions: Record<string, unknown>;
  };
}

function makeClassifierEnv(
  respond: () => unknown = () => DECIDED,
  wsOver: Partial<WorkspaceRecord> = {},
  opts: {
    lunaFlag?: boolean;
    provider?: string;
    openRouterKey?: string;
    status?: number;
    hangUntilAbort?: boolean;
  } = {},
) {
  const { env, db, ws } = makePosterEnv();
  const calls: DecisionCall[] = [];
  const flagCalls: unknown[] = [];
  let aborted = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url !== OPENROUTER_DECISIONS_URL) {
        throw new Error(`unexpected fetch ${url}`);
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as DecisionCall["body"];
      calls.push({
        url,
        headers: init?.headers as Record<string, string>,
        body,
      });
      if (opts.hangUntilAbort) {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          const fail = () => {
            aborted = true;
            reject(new DOMException("The operation was aborted", "AbortError"));
          };
          if (signal?.aborted) fail();
          else signal?.addEventListener("abort", fail);
        });
      }
      const payload = respond();
      if (payload instanceof Error) throw payload;
      return new Response(JSON.stringify(payload), {
        status: opts.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const patched = {
    ...env,
    AI: {
      run: () => {
        throw new Error("workers ai should not run");
      },
      gateway: () => {
        throw new Error("ai gateway should not run");
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
    OPENROUTER_API_KEY: opts.openRouterKey === undefined ? "test-key" : opts.openRouterKey,
  } as unknown as Env;
  const workspace: WorkspaceRecord = { ...ws, name: WORKSPACE, ...wsOver };
  return { env: patched, db, ws: workspace, calls, flagCalls, wasAborted: () => aborted };
}

function stateText(call: DecisionCall | undefined): string {
  return String(call?.body.state[0] ?? "");
}

function stateImage(
  call: DecisionCall | undefined,
): { type?: string; image_url?: { url?: string } } | undefined {
  return call?.body.state[1] as { type?: string; image_url?: { url?: string } } | undefined;
}

describe("classifier on upload", () => {
  it("writes server-owned ai.* metadata after one Decisions call", async () => {
    const { env, ws, calls } = makeClassifierEnv();
    const pending: Promise<unknown>[] = [];
    const result = await putObject(env, ws, "images/pic.png", PNG, WORKSPACE, {
      waitUntil: (p) => pending.push(p),
    });
    await Promise.all(pending);
    const metaByKey = await getMetadataForKeys(env.DB, WORKSPACE, [result.key]);
    const meta = metaByKey.get(result.key);
    expect(meta?.["ai.classifier"]).toBe(CLASSIFIER_VERSION);
    expect(meta?.["ai.kind"]).toBe("screenshot");
    expect(meta?.["ai.surface"]).toBe("desktop");
    expect(meta?.["ai.screen"]).toBe("settings");
    expect(meta?.["ai.tags"]).toBeUndefined();
    expect(meta?.["ai.summary"]).toBeUndefined();
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(call.url).not.toContain("/api/v1/");
    expect(call.headers.Authorization).toBe("Bearer test-key");
    expect(call.body.model).toBe(CLASSIFIER_JEV_MODEL);
    expect(stateText(call)).toContain("filename: pic.png");
    expect(stateText(call)).toContain("dimensions unknown");
    expect(stateImage(call)).toBeUndefined();
  });

  it("sends a fitting PNG as an image_url part and skips Workers AI", async () => {
    const png = pngOf(400, 256);
    const { env, ws, calls } = makeClassifierEnv();
    const written = await classifyAndStore(env, ws, WORKSPACE, "images/pic.png", png, "image/png");
    expect(written?.["ai.classifier"]).toBe("v5");
    expect(calls).toHaveLength(1);
    const image = stateImage(calls[0]);
    expect(image?.type).toBe("image_url");
    expect(image?.image_url?.url?.startsWith("data:image/png;base64,")).toBe(true);
    const b64 = image!.image_url!.url!.slice("data:image/png;base64,".length);
    expect(Uint8Array.from(Buffer.from(b64, "base64"))).toEqual(png);
    expect(stateText(calls[0])).toContain("image_width: 400");
    expect(stateText(calls[0])).not.toContain("base64");
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
    expect(meta?.["ai.kind"]).toBe("screenshot");
  });

  it("does not fail the upload when OpenRouter throws", async () => {
    const { env, ws } = makeClassifierEnv(() => {
      throw new Error("openrouter down");
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
    const { env, ws, calls } = makeClassifierEnv(() => DECIDED, { llmClassifierEnabled: false });
    const pending: Promise<unknown>[] = [];
    await putObject(env, ws, "images/pic.png", PNG, WORKSPACE, {
      waitUntil: (p) => pending.push(p),
    });
    await Promise.all(pending);
    expect(calls).toHaveLength(0);
  });

  it("classifies when llmClassifierEnabled is unset (Flagship is the allowlist)", async () => {
    const { env, ws, calls } = makeClassifierEnv(() => DECIDED, {
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

  it("writes nothing when the OpenRouter key is missing", async () => {
    const { env, ws, calls } = makeClassifierEnv(() => DECIDED, {}, { openRouterKey: "  " });
    const pending: Promise<unknown>[] = [];
    const result = await putObject(env, ws, "images/pic.png", PNG, WORKSPACE, {
      waitUntil: (p) => pending.push(p),
    });
    await Promise.all(pending);
    expect(calls).toHaveLength(0);
    const written = await classifyAndStore(env, ws, WORKSPACE, "images/pic.png", PNG, "image/png");
    expect(written).toBeUndefined();
    expect(calls).toHaveLength(0);
    const metaByKey = await getMetadataForKeys(env.DB, WORKSPACE, [result.key]);
    expect(metaByKey.get(result.key)?.["ai.classifier"]).toBeUndefined();
  });
});

describe("classifyAndStore", () => {
  it("drops an enum whose confidence is under the threshold", async () => {
    const { env, ws } = makeClassifierEnv(() => ({
      answers: { kind: jevAnswer("photo", 0.95), screen: jevAnswer("checkout", 0.2) },
    }));
    const written = await classifyAndStore(env, ws, WORKSPACE, "images/pic.png", PNG, "image/png");
    expect(written?.["ai.kind"]).toBe("photo");
    expect(written?.["ai.screen"]).toBeUndefined();
    expect(written?.["ai.classifier"]).toBe("v5");
  });

  it("sends a text file as facts with no image and writes no tags", async () => {
    const { env, ws, calls } = makeClassifierEnv();
    const bytes = new TextEncoder().encode("hello world\n");
    const written = await classifyAndStore(env, ws, WORKSPACE, "notes.txt", bytes, "text/plain");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.model).toBe(CLASSIFIER_JEV_MODEL);
    expect(calls[0]?.body.state).toHaveLength(1);
    expect(stateText(calls[0])).toContain("hello world");
    expect(written?.["ai.tags"]).toBeUndefined();
    expect(written?.["ai.summary"]).toBeUndefined();
    expect(written?.["ai.kind"]).toBe("screenshot");
  });

  it("leaves an oversized or out-of-window image off the request", async () => {
    const { env, ws, calls } = makeClassifierEnv();
    const big = new Uint8Array(CLASSIFIER_MAX_IMAGE_BYTES + 1);
    await classifyAndStore(env, ws, WORKSPACE, "huge.png", big, "image/png");
    expect(stateImage(calls[0])).toBeUndefined();
    expect(stateText(calls[0])).toContain("image skipped");

    const wide = pngOf(1600, 900);
    await classifyAndStore(env, ws, WORKSPACE, "wide.png", wide, "image/png");
    expect(stateImage(calls[1])).toBeUndefined();
    expect(stateText(calls[1])).toContain("outside jev pixel limits");
    expect(stateText(calls[1])).toContain("image_width: 1600");
  });

  it("writes nothing when the decision model returns unusable output", async () => {
    const { env, ws } = makeClassifierEnv(() => ({ response: "nope" }));
    const written = await classifyAndStore(env, ws, WORKSPACE, "images/pic.png", PNG, "image/png");
    expect(written).toBeUndefined();
    const metaByKey = await getMetadataForKeys(env.DB, WORKSPACE, ["images/pic.png"]);
    expect(metaByKey.get("images/pic.png")?.["ai.classifier"]).toBeUndefined();
  });

  it("does not wait out a hung call", async () => {
    const { env, ws, wasAborted } = makeClassifierEnv(() => DECIDED, {}, { hangUntilAbort: true });
    const started = Date.now();
    const written = await classifyAndStore(env, ws, WORKSPACE, "images/pic.png", PNG, "image/png", {
      timeoutMs: 20,
    });
    expect(written).toBeUndefined();
    expect(wasAborted()).toBe(true);
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

  it("pins Jev Latest when CLASSIFIER_PROVIDER=jev even if the luna flag is on", async () => {
    const { env, ws, calls } = makeClassifierEnv(
      () => DECIDED,
      {},
      { provider: "jev", lunaFlag: true, openRouterKey: "test-key" },
    );
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "images/pic.png",
      pngOf(400, 256),
      "image/png",
    );
    expect(written?.["ai.classifier"]).toBe("v5");
    expect(written?.["ai.tags"]).toBeUndefined();
    expect(calls.map((call) => call.body.model)).toEqual([CLASSIFIER_JEV_MODEL]);
    expect(stateImage(calls[0])?.type).toBe("image_url");
  });

  it("fails open when OpenRouter returns an error", async () => {
    const { env, ws } = makeClassifierEnv(() => DECIDED, {}, { status: 502 });
    const written = await classifyAndStore(env, ws, WORKSPACE, "images/pic.png", PNG, "image/png");
    expect(written).toBeUndefined();
  });
});

describe("luna decisions provider", () => {
  function lunaBase(opts: { viaFlag?: boolean; openRouterKey?: string } = {}) {
    return makeClassifierEnv(
      () => DECIDED,
      {},
      {
        provider: opts.viaFlag ? undefined : "luna",
        lunaFlag: opts.viaFlag === true,
        openRouterKey: opts.openRouterKey ?? "test-key",
      },
    );
  }

  it("classifies an out-of-window image in one call and attaches the pixels", async () => {
    const png = pngOf(1600, 900);
    const { env, ws, calls } = lunaBase();
    const pending: Promise<unknown>[] = [];
    const result = await putObject(env, ws, "images/pic.png", png, WORKSPACE, {
      waitUntil: (p) => pending.push(p),
    });
    await Promise.all(pending);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(OPENROUTER_DECISIONS_URL);
    expect(call.headers.Authorization).toBe("Bearer test-key");
    expect(call.body.model).toBe(CLASSIFIER_LUNA_MODEL);
    expect(stateText(call)).toContain("filename: pic.png");
    expect(stateText(call)).not.toContain("pixel limits");
    const image = stateImage(call);
    expect(image?.type).toBe("image_url");
    expect(image?.image_url?.url?.startsWith("data:image/png;base64,")).toBe(true);

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
    const { env, ws, calls } = lunaBase();
    const bytes = new TextEncoder().encode("export const n = 1;\n");
    const written = await classifyAndStore(env, ws, WORKSPACE, "src/n.ts", bytes, "text/plain");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.state).toHaveLength(1);
    expect(stateText(calls[0])).toContain("export const n");
    expect(written?.["ai.classifier"]).toBe(CLASSIFIER_LUNA_VERSION);
    expect(written?.["ai.kind"]).toBe("screenshot");
    expect(written?.["ai.tags"]).toBeUndefined();
  });

  it("does not attach an oversized image", async () => {
    const { env, ws, calls } = lunaBase();
    const big = new Uint8Array(CLASSIFIER_MAX_IMAGE_BYTES + 1);
    const written = await classifyAndStore(env, ws, WORKSPACE, "huge.png", big, "image/png");
    expect(stateImage(calls[0])).toBeUndefined();
    expect(stateText(calls[0])).toContain("image skipped");
    expect(written?.["ai.classifier"]).toBe(CLASSIFIER_LUNA_VERSION);
  });

  it("selects luna from the flag when CLASSIFIER_PROVIDER is unset", async () => {
    const { env, ws, calls } = lunaBase({ viaFlag: true });
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "notes.txt",
      new TextEncoder().encode("hi\n"),
      "text/plain",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.model).toBe(CLASSIFIER_LUNA_MODEL);
    expect(written?.["ai.classifier"]).toBe("v4");
  });
});
