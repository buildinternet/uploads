import { afterEach, describe, expect, it, vi } from "vitest";
import { putObject } from "../src/files-core";
import { findObjectsByMetadata, getMetadataForKeys } from "../src/file-metadata";
import {
  CLASSIFIER_JEV_MODEL,
  CLASSIFIER_LUNA_MODEL,
  CLASSIFIER_LUNA_VERSION,
  CLASSIFIER_MAX_IMAGE_BYTES,
  CLASSIFIER_RESIZED_VERSION,
  CLASSIFIER_SKIP_MIN_BYTES,
  CLASSIFIER_SKIP_MIN_EDGE,
  CLASSIFIER_SKIP_SMALL,
  CLASSIFIER_SKIPPED,
  CLASSIFIER_VERSION,
  type ClassifierResizeRequest,
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

/**
 * Header fixtures are a few dozen bytes. Copies that must still reach the
 * model are padded to the skip floor. The header, and therefore the
 * dimensions, stay at the front.
 */
function atLeast(bytes: Uint8Array, min = CLASSIFIER_SKIP_MIN_BYTES): Uint8Array {
  if (bytes.byteLength >= min) return bytes;
  const out = new Uint8Array(min);
  out.set(bytes);
  return out;
}

/** PNG signature with no IHDR, large enough that the byte floor does not skip it. */
const CLASSIFIABLE_PNG = atLeast(PNG);

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
    const result = await putObject(env, ws, "images/pic.png", CLASSIFIABLE_PNG, WORKSPACE, {
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
    expect(Object.keys(call.body.questions)).toEqual([
      "kind",
      "surface",
      "screen",
      "rating",
      "content",
      "secret",
      "pii",
    ]);
    expect(stateText(call)).toContain("filename: pic.png");
    expect(stateText(call)).toContain("dimensions unknown");
    expect(stateImage(call)).toBeUndefined();
  });

  it("sends a fitting PNG as an image_url part and skips Workers AI", async () => {
    const png = atLeast(pngOf(400, 256));
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
    const result = await putObject(env, ws, "images/pic.png", CLASSIFIABLE_PNG, WORKSPACE, {
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
    const result = await putObject(env, ws, "images/pic.png", CLASSIFIABLE_PNG, WORKSPACE, {
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
    await putObject(env, ws, "images/pic.png", CLASSIFIABLE_PNG, WORKSPACE, {
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
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "images/pic.png",
      CLASSIFIABLE_PNG,
      "image/png",
    );
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
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "images/pic.png",
      CLASSIFIABLE_PNG,
      "image/png",
    );
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

    const wide = atLeast(pngOf(1600, 900));
    await classifyAndStore(env, ws, WORKSPACE, "wide.png", wide, "image/png");
    expect(stateImage(calls[1])).toBeUndefined();
    expect(stateText(calls[1])).toContain("transform unavailable");
    expect(stateText(calls[1])).toContain("image_width: 1600");
  });

  it("writes nothing when the decision model returns unusable output", async () => {
    const { env, ws } = makeClassifierEnv(() => ({ response: "nope" }));
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "images/pic.png",
      CLASSIFIABLE_PNG,
      "image/png",
    );
    expect(written).toBeUndefined();
    const metaByKey = await getMetadataForKeys(env.DB, WORKSPACE, ["images/pic.png"]);
    expect(metaByKey.get("images/pic.png")?.["ai.classifier"]).toBeUndefined();
  });

  it("does not wait out a hung call", async () => {
    const { env, ws, wasAborted } = makeClassifierEnv(() => DECIDED, {}, { hangUntilAbort: true });
    const started = Date.now();
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "images/pic.png",
      CLASSIFIABLE_PNG,
      "image/png",
      {
        timeoutMs: 20,
      },
    );
    expect(written).toBeUndefined();
    expect(wasAborted()).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("swallows runner errors", async () => {
    const { env, ws } = makeClassifierEnv();
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "images/pic.png",
      CLASSIFIABLE_PNG,
      "image/png",
      {
        run: async () => {
          throw new Error("boom");
        },
      },
    );
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
      atLeast(pngOf(400, 256)),
      "image/png",
    );
    expect(written?.["ai.classifier"]).toBe("v5");
    expect(written?.["ai.tags"]).toBeUndefined();
    expect(calls.map((call) => call.body.model)).toEqual([CLASSIFIER_JEV_MODEL]);
    expect(stateImage(calls[0])?.type).toBe("image_url");
  });

  it("fails open when OpenRouter returns an error", async () => {
    const { env, ws } = makeClassifierEnv(() => DECIDED, {}, { status: 502 });
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "images/pic.png",
      CLASSIFIABLE_PNG,
      "image/png",
    );
    expect(written).toBeUndefined();
  });
});

function jpegOf(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x00, 0x00,
    0x00, 0x03,
  ]);
  const view = new DataView(bytes.buffer);
  view.setUint16(13, height, false);
  view.setUint16(15, width, false);
  return bytes;
}

function gifOf(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(10);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

function recordingTransform(outputFor: (request: ClassifierResizeRequest) => Uint8Array): {
  resize: (bytes: Uint8Array, request: ClassifierResizeRequest) => Promise<Uint8Array>;
  calls: ClassifierResizeRequest[];
} {
  const calls: ClassifierResizeRequest[] = [];
  return {
    calls,
    async resize(_bytes, request) {
      calls.push(request);
      return outputFor(request);
    },
  };
}

describe("classifier image resize", () => {
  it("sends an oversized screenshot as a classifier-sized image and marks v6", async () => {
    const output = pngOf(1568, 980);
    const transform = recordingTransform(() => output);
    const { env, ws, calls } = makeClassifierEnv();
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "shots/retina.png",
      atLeast(pngOf(2880, 1800)),
      "image/png",
      { transform },
    );
    expect(transform.calls).toHaveLength(1);
    expect(transform.calls[0]).toMatchObject({
      width: 1568,
      height: 1568,
      fit: "scale-down",
      format: "image/png",
    });
    expect(written?.["ai.classifier"]).toBe(CLASSIFIER_RESIZED_VERSION);
    expect(stateText(calls[0])).toContain("image_width: 2880");
    expect(stateText(calls[0])).toContain("image_height: 1800");
    expect(stateText(calls[0])).toContain("image prepared for classification: 1568x980 png");
    const image = stateImage(calls[0]);
    expect(image?.image_url?.url?.startsWith("data:image/png;base64,")).toBe(true);
    const b64 = image!.image_url!.url!.slice("data:image/png;base64,".length);
    expect(Uint8Array.from(Buffer.from(b64, "base64"))).toEqual(output);
  });

  it("does not upscale an undersized image", async () => {
    const transform = recordingTransform(() => {
      throw new Error("should not resize");
    });
    const { env, ws, calls } = makeClassifierEnv();
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "icons/tiny.png",
      atLeast(pngOf(100, 100)),
      "image/png",
      { transform },
    );
    expect(transform.calls).toHaveLength(0);
    expect(stateImage(calls[0])).toBeUndefined();
    expect(stateText(calls[0])).toContain("below jev pixel limits");
    expect(stateText(calls[0])).toContain("image_width: 100");
    expect(written?.["ai.classifier"]).toBe(CLASSIFIER_VERSION);
  });

  it("sends a WebP as a JPEG still", async () => {
    const output = jpegOf(640, 480);
    const transform = recordingTransform((request) => {
      expect(request.format).toBe("image/jpeg");
      return output;
    });
    const { env, ws, calls } = makeClassifierEnv();
    const webp = atLeast(new Uint8Array(30));
    webp.set([0x52, 0x49, 0x46, 0x46]);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    webp.set([0x56, 0x50, 0x38, 0x58], 12);
    webp[24] = 0x7f;
    webp[25] = 0x02;
    webp[27] = 0xdf;
    webp[28] = 0x01;
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "shots/ui.webp",
      webp,
      "image/webp",
      {
        transform,
      },
    );
    expect(transform.calls[0]?.format).toBe("image/jpeg");
    expect(written?.["ai.classifier"]).toBe(CLASSIFIER_RESIZED_VERSION);
    expect(stateText(calls[0])).toContain("content_type: image/webp");
    expect(stateText(calls[0])).toContain("image_width: 640");
    expect(stateImage(calls[0])?.image_url?.url?.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("sends a GIF as a JPEG still", async () => {
    const output = jpegOf(1568, 980);
    const transform = recordingTransform(() => output);
    const { env, ws, calls } = makeClassifierEnv();
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "shots/walk.gif",
      atLeast(gifOf(2880, 1800)),
      "image/gif",
      { transform },
    );
    expect(transform.calls[0]?.format).toBe("image/jpeg");
    expect(written?.["ai.classifier"]).toBe(CLASSIFIER_RESIZED_VERSION);
    expect(stateText(calls[0])).toContain("content_type: image/gif");
    expect(stateText(calls[0])).toContain("image_width: 2880");
    expect(stateImage(calls[0])?.image_url?.url?.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("sends an AVIF as a JPEG still", async () => {
    const output = jpegOf(1024, 768);
    const transform = recordingTransform(() => output);
    const { env, ws, calls } = makeClassifierEnv();
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "shots/ui.avif",
      atLeast(new Uint8Array([0, 1, 2, 3])),
      "image/avif",
      { transform },
    );
    expect(transform.calls[0]?.format).toBe("image/jpeg");
    expect(written?.["ai.classifier"]).toBe(CLASSIFIER_RESIZED_VERSION);
    expect(stateImage(calls[0])?.image_url?.url?.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("keeps classifying from text facts when the transform fails", async () => {
    const transform = recordingTransform(() => {
      throw new Error("images down");
    });
    const { env, ws, calls } = makeClassifierEnv();
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "shots/retina.png",
      atLeast(pngOf(2880, 1800)),
      "image/png",
      { transform },
    );
    expect(calls).toHaveLength(1);
    expect(stateImage(calls[0])).toBeUndefined();
    expect(stateText(calls[0])).toContain("transform failed");
    expect(stateText(calls[0])).toContain("image_width: 2880");
    expect(written?.["ai.classifier"]).toBe(CLASSIFIER_VERSION);
    expect(written?.["ai.kind"]).toBe("screenshot");
  });

  it("uses env.IMAGES when no transform override is passed", async () => {
    const output = pngOf(1568, 980);
    const { env, ws, calls } = makeClassifierEnv();
    env.IMAGES = {
      input(stream: ReadableStream<Uint8Array>) {
        return {
          transform() {
            return {
              output() {
                return new Response(stream).arrayBuffer().then(() => ({
                  contentType: () => "image/png",
                  response: () => new Response(output),
                  image: () =>
                    new ReadableStream<Uint8Array>({
                      start(controller) {
                        controller.enqueue(output);
                        controller.close();
                      },
                    }),
                }));
              },
            };
          },
        };
      },
    } as unknown as ImagesBinding;
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "shots/retina.png",
      atLeast(pngOf(2880, 1800)),
      "image/png",
    );
    expect(written?.["ai.classifier"]).toBe(CLASSIFIER_RESIZED_VERSION);
    const image = stateImage(calls[0]);
    const b64 = image!.image_url!.url!.slice("data:image/png;base64,".length);
    expect(Uint8Array.from(Buffer.from(b64, "base64"))).toEqual(output);
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
    const png = atLeast(pngOf(1600, 900));
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

  it("does not resize a large screenshot for luna", async () => {
    const png = atLeast(pngOf(2880, 1800));
    const { env, ws, calls } = lunaBase();
    env.IMAGES = {
      input() {
        throw new Error("luna must not transform");
      },
    } as unknown as ImagesBinding;
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "shots/retina.png",
      png,
      "image/png",
    );
    expect(written?.["ai.classifier"]).toBe(CLASSIFIER_LUNA_VERSION);
    expect(stateText(calls[0])).toContain("image_width: 2880");
    expect(stateText(calls[0])).not.toContain("prepared for classification");
    const image = stateImage(calls[0]);
    expect(image?.image_url?.url?.startsWith("data:image/png;base64,")).toBe(true);
    const b64 = image!.image_url!.url!.slice("data:image/png;base64,".length);
    expect(Uint8Array.from(Buffer.from(b64, "base64"))).toEqual(png);
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

describe("trivial image skip", () => {
  it("does not call the model for a 1x1 image on Jev or Luna", async () => {
    const pixel = pngOf(1, 1);
    const jev = makeClassifierEnv();
    const jevTransform = recordingTransform(() => {
      throw new Error("should not resize");
    });
    const written = await classifyAndStore(
      jev.env,
      jev.ws,
      WORKSPACE,
      "t/pixel.png",
      pixel,
      "image/png",
      { transform: jevTransform },
    );
    expect(jev.calls).toHaveLength(0);
    expect(jevTransform.calls).toHaveLength(0);
    expect(written).toEqual({
      "ai.classifier": CLASSIFIER_SKIPPED,
      "ai.skip": CLASSIFIER_SKIP_SMALL,
    });

    const luna = makeClassifierEnv(() => DECIDED, {}, { provider: "luna" });
    const lunaWritten = await classifyAndStore(
      luna.env,
      luna.ws,
      WORKSPACE,
      "t/pixel.png",
      pixel,
      "image/png",
    );
    expect(luna.calls).toHaveLength(0);
    expect(lunaWritten).toEqual({
      "ai.classifier": CLASSIFIER_SKIPPED,
      "ai.skip": CLASSIFIER_SKIP_SMALL,
    });
  });

  it("skips a small icon whose file is over the byte floor", async () => {
    const icon = atLeast(pngOf(32, 32), CLASSIFIER_SKIP_MIN_BYTES + 1);
    const { env, ws, calls } = makeClassifierEnv();
    const written = await classifyAndStore(env, ws, WORKSPACE, "icons/app.png", icon, "image/png");
    expect(calls).toHaveLength(0);
    expect(written).toEqual({
      "ai.classifier": CLASSIFIER_SKIPPED,
      "ai.skip": CLASSIFIER_SKIP_SMALL,
    });
  });

  it("classifies a 64 px image of exactly 2 KiB", async () => {
    const icon = atLeast(pngOf(CLASSIFIER_SKIP_MIN_EDGE, CLASSIFIER_SKIP_MIN_EDGE));
    expect(icon.byteLength).toBe(CLASSIFIER_SKIP_MIN_BYTES);
    const { env, ws, calls } = makeClassifierEnv();
    const written = await classifyAndStore(env, ws, WORKSPACE, "icons/app.png", icon, "image/png");
    expect(calls).toHaveLength(1);
    expect(stateImage(calls[0])).toBeUndefined();
    expect(stateText(calls[0])).toContain("below jev pixel limits");
    expect(stateText(calls[0])).toContain("image_width: 64");
    expect(written?.["ai.classifier"]).toBe(CLASSIFIER_VERSION);
    expect(written?.["ai.skip"]).toBeUndefined();
  });

  it("skips unknown dimensions under 2 KiB and classifies a file at 2 KiB", async () => {
    const tiny = makeClassifierEnv();
    const skipped = await classifyAndStore(
      tiny.env,
      tiny.ws,
      WORKSPACE,
      "images/pic.png",
      PNG,
      "image/png",
    );
    expect(tiny.calls).toHaveLength(0);
    expect(skipped).toEqual({
      "ai.classifier": CLASSIFIER_SKIPPED,
      "ai.skip": CLASSIFIER_SKIP_SMALL,
    });

    const { env, ws, calls } = makeClassifierEnv();
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "images/pic.png",
      CLASSIFIABLE_PNG,
      "image/png",
    );
    expect(CLASSIFIABLE_PNG.byteLength).toBe(CLASSIFIER_SKIP_MIN_BYTES);
    expect(calls).toHaveLength(1);
    expect(stateText(calls[0])).toContain("dimensions unknown");
    expect(stateImage(calls[0])).toBeUndefined();
    expect(written?.["ai.classifier"]).toBe(CLASSIFIER_VERSION);
    expect(written?.["ai.skip"]).toBeUndefined();
  });

  it("stores the skip marker on the uploaded file", async () => {
    const { env, ws, calls } = makeClassifierEnv();
    const pending: Promise<unknown>[] = [];
    const result = await putObject(env, ws, "images/pixel.png", pngOf(1, 1), WORKSPACE, {
      waitUntil: (p) => pending.push(p),
    });
    await Promise.all(pending);
    expect(calls).toHaveLength(0);
    const meta = (await getMetadataForKeys(env.DB, WORKSPACE, [result.key])).get(result.key);
    expect(meta?.["ai.classifier"]).toBe(CLASSIFIER_SKIPPED);
    expect(meta?.["ai.skip"]).toBe(CLASSIFIER_SKIP_SMALL);
    expect(meta?.["ai.kind"]).toBeUndefined();
    expect(meta?.["ai.secret"]).toBeUndefined();
    expect(meta?.["ai.pii"]).toBeUndefined();
    expect(meta?.["ai.rating"]).toBeUndefined();
  });
});

describe("safety flags", () => {
  it("stores rating, content, secret, and pii from the same call", async () => {
    const { env, ws, calls } = makeClassifierEnv(() => ({
      ...DECIDED,
      answers: {
        ...DECIDED.answers,
        rating: jevAnswer("safe", 0.93),
        content: jevAnswer("none", 0.9),
        secret: jevAnswer("api_key", 0.88),
        pii: jevAnswer("none", 0.55),
      },
    }));
    const png = atLeast(pngOf(400, 256));
    const written = await classifyAndStore(env, ws, WORKSPACE, "images/leak.png", png, "image/png");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.model).toBe(CLASSIFIER_JEV_MODEL);
    expect(written?.["ai.classifier"]).toBe(CLASSIFIER_VERSION);
    expect(written?.["ai.kind"]).toBe("screenshot");
    expect(written?.["ai.rating"]).toBe("safe");
    expect(written?.["ai.rating.confidence"]).toBe("high");
    expect(written?.["ai.content"]).toBe("none");
    expect(written?.["ai.content.confidence"]).toBe("high");
    expect(written?.["ai.secret"]).toBe("api_key");
    expect(written?.["ai.secret.confidence"]).toBe("high");
    expect(written?.["ai.pii"]).toBe("none");
    expect(written?.["ai.pii.confidence"]).toBe("low");
    expect(written?.["ai.kind.confidence"]).toBeUndefined();

    const found = await findObjectsByMetadata(env.DB, WORKSPACE, { "ai.secret": "api_key" });
    expect(found.map((match) => match.key)).toEqual(["images/leak.png"]);
    expect(found[0]?.metadata["ai.secret"]).toBe("api_key");
    expect(found[0]?.metadata["ai.pii"]).toBe("none");
  });

  it("keeps the Luna version when the same questions are answered", async () => {
    const { env, ws, calls } = makeClassifierEnv(
      () => ({
        ...DECIDED,
        answers: {
          ...DECIDED.answers,
          secret: jevAnswer("password", 0.8),
          pii: jevAnswer("contact", 0.7),
        },
      }),
      {},
      { provider: "luna" },
    );
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "notes/creds.txt",
      new TextEncoder().encode("password = hunter2\n"),
      "text/plain",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.model).toBe(CLASSIFIER_LUNA_MODEL);
    expect(Object.keys(calls[0]?.body.questions ?? {})).toEqual([
      "kind",
      "surface",
      "screen",
      "rating",
      "content",
      "secret",
      "pii",
    ]);
    expect(written?.["ai.classifier"]).toBe(CLASSIFIER_LUNA_VERSION);
    expect(written?.["ai.secret"]).toBe("password");
    expect(written?.["ai.secret.confidence"]).toBe("medium");
    expect(written?.["ai.pii"]).toBe("contact");
    expect(written?.["ai.pii.confidence"]).toBe("medium");
  });
});
