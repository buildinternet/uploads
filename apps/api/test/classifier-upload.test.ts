import { encode } from "jpeg-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteObject, putObject } from "../src/files-core";
import { FakeR2Bucket } from "./fake-r2";
import { findObjectsByMetadata, getMetadataForKeys } from "../src/file-metadata";
import {
  CLASSIFIER_JEV_MODEL,
  CLASSIFIER_LUNA_MODEL,
  CLASSIFIER_LUNA_VERSION,
  CLASSIFIER_MAX_IMAGE_BYTES,
  CLASSIFIER_RESIZED_VERSION,
  CLASSIFIER_SKIP_MIN_BYTES,
  CLASSIFIER_SKIP_MIN_EDGE,
  CLASSIFIER_SKIP_RESIZE_FAILED,
  CLASSIFIER_SKIP_RESIZE_TIMEOUT,
  CLASSIFIER_SKIP_SMALL,
  CLASSIFIER_SKIP_UNSUPPORTED,
  CLASSIFIER_SKIPPED,
  CLASSIFIER_VERSION,
  type ClassifierResizeRequest,
  DECISIONS_DANGER_ZONE_HEADER,
  HOLD_AREA_INSTRUCTIONS,
  OPENROUTER_DECISIONS_URL,
  classifyAndStore,
} from "../src/classifier";
import { makePosterEnv, PNG, WORKSPACE } from "./poster-fixtures";
import { approveUpload } from "../src/upload-hold-service";
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

const FLAGGED = {
  ...DECIDED,
  answers: {
    ...DECIDED.answers,
    rating: jevAnswer("explicit", 0.95),
    content: jevAnswer("sexual", 0.91),
    secret: jevAnswer("api_key", 0.9),
    pii: jevAnswer("financial", 0.8),
  },
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

/** Inside Jev's window, so the model sees the original bytes. */
const FITTING_PNG = atLeast(pngOf(400, 280));

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
    holdFlag?: boolean;
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
        if (args[0] === "upload-holds") return opts.holdFlag !== false;
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

type ClassifierHarness = Pick<ReturnType<typeof makeClassifierEnv>, "env" | "ws">;

async function putFlagged(
  harness: ClassifierHarness,
  bytes: Uint8Array,
  opts: { replace?: boolean; metadata?: Record<string, string>; enforceHold?: boolean } = {},
) {
  const pending: Promise<unknown>[] = [];
  const result = await putObject(harness.env, harness.ws, "images/flagged.png", bytes, WORKSPACE, {
    ...opts,
    waitUntil: (work) => {
      pending.push(work);
    },
  });
  await Promise.all(pending);
  return result;
}

/** 400×280 JPEG inside Jev's window. `comment` changes the bytes, not the pixels. */
function jpegFrame(seed: number, comment?: string): Uint8Array {
  const width = 400;
  const height = 280;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x + seed) & 255;
      data[i + 1] = (y * 3) & 255;
      data[i + 2] = (x * 3 + y + seed) & 255;
      data[i + 3] = 255;
    }
  }
  const encoded = encode({ data, width, height, ...(comment ? { comments: [comment] } : {}) }, 80);
  return new Uint8Array(encoded.data);
}

async function putImage(
  harness: ReturnType<typeof makeClassifierEnv>,
  key: string,
  bytes: Uint8Array,
  workspace = WORKSPACE,
) {
  const pending: Promise<unknown>[] = [];
  const result = await putObject(harness.env, harness.ws, key, bytes, workspace, {
    waitUntil: (work) => {
      pending.push(work);
    },
  });
  await Promise.all(pending);
  return result;
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
    const result = await putObject(env, ws, "images/pic.png", FITTING_PNG, WORKSPACE, {
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
      "credential",
      "pii",
    ]);
    expect(stateText(call)).toContain("filename: pic.png");
    expect(stateImage(call)?.type).toBe("image_url");
  });

  it("sends a fitting PNG as an image_url part and skips Workers AI", async () => {
    const png = atLeast(pngOf(400, 280));
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
    const result = await putObject(env, ws, "images/pic.png", FITTING_PNG, WORKSPACE, {
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
    const result = await putObject(env, ws, "images/pic.png", FITTING_PNG, WORKSPACE, {
      waitUntil: (p) => pending.push(p),
    });
    expect(result.key).toBe("images/pic.png");
    expect(result.contentType).toBe("image/png");
    await Promise.all(pending);
    const metaByKey = await getMetadataForKeys(env.DB, WORKSPACE, [result.key]);
    expect(metaByKey.get(result.key)?.["ai.classifier"]).toBe("failed");
    expect(metaByKey.get(result.key)?.["ai.error"]).toBe("provider_error");
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
    await putObject(env, ws, "images/pic.png", FITTING_PNG, WORKSPACE, {
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

  it("marks the put holdCheck pending only when a hold could follow", async () => {
    const harness = makeClassifierEnv();
    expect((await putFlagged(harness, FITTING_PNG, { enforceHold: true })).holdCheck).toBe(
      "pending",
    );
    // A client that cannot approve is never held.
    expect((await putFlagged(harness, FITTING_PNG, { replace: true })).holdCheck).toBeUndefined();
    // No classification without waitUntil.
    const plain = await putObject(harness.env, harness.ws, "images/pic.png", PNG, WORKSPACE, {
      enforceHold: true,
    });
    expect(plain.holdCheck).toBeUndefined();
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
      FITTING_PNG,
      "image/png",
    );
    expect(written?.["ai.kind"]).toBe("photo");
    expect(written?.["ai.screen"]).toBeUndefined();
    expect(written?.["ai.classifier"]).toBe("v5");
  });

  it("does not send a text-only request", async () => {
    const { env, ws, calls } = makeClassifierEnv();
    const bytes = new TextEncoder().encode("hello world\n");
    const written = await classifyAndStore(env, ws, WORKSPACE, "notes.txt", bytes, "text/plain");
    expect(calls).toHaveLength(0);
    expect(written).toEqual({
      "ai.classifier": CLASSIFIER_SKIPPED,
      "ai.skip": CLASSIFIER_SKIP_UNSUPPORTED,
    });

    const svg = atLeast(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"));
    const svgWritten = await classifyAndStore(env, ws, WORKSPACE, "icon.svg", svg, "image/svg+xml");
    expect(svgWritten?.["ai.skip"]).toBe(CLASSIFIER_SKIP_UNSUPPORTED);
    expect(svgWritten?.["ai.kind"]).toBeUndefined();
    expect(svgWritten?.["ai.secret"]).toBeUndefined();

    const luna = makeClassifierEnv(() => DECIDED, {}, { provider: "luna" });
    const lunaText = await classifyAndStore(
      luna.env,
      luna.ws,
      WORKSPACE,
      "src/n.ts",
      new TextEncoder().encode("export const n = 1;\n"),
      "text/plain",
    );
    expect(lunaText?.["ai.skip"]).toBe(CLASSIFIER_SKIP_UNSUPPORTED);
    const big = new Uint8Array(CLASSIFIER_MAX_IMAGE_BYTES + 1);
    const lunaBig = await classifyAndStore(
      luna.env,
      luna.ws,
      WORKSPACE,
      "huge.png",
      big,
      "image/png",
    );
    expect(lunaBig).toEqual({
      "ai.classifier": CLASSIFIER_SKIPPED,
      "ai.skip": CLASSIFIER_SKIP_UNSUPPORTED,
    });
    expect(calls).toHaveLength(0);
    expect(luna.calls).toHaveLength(0);
  });

  it("skips when a resize is required and the binding is missing", async () => {
    const { env, ws, calls } = makeClassifierEnv();
    const big = new Uint8Array(CLASSIFIER_MAX_IMAGE_BYTES + 1);
    const oversized = await classifyAndStore(env, ws, WORKSPACE, "huge.png", big, "image/png");
    expect(oversized).toEqual({
      "ai.classifier": CLASSIFIER_SKIPPED,
      "ai.skip": CLASSIFIER_SKIP_RESIZE_FAILED,
    });

    const wide = atLeast(pngOf(1600, 900));
    const wideWritten = await classifyAndStore(env, ws, WORKSPACE, "wide.png", wide, "image/png");
    expect(wideWritten?.["ai.skip"]).toBe(CLASSIFIER_SKIP_RESIZE_FAILED);
    expect(wideWritten?.["ai.kind"]).toBeUndefined();
    expect(wideWritten?.["ai.rating"]).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("records no_answer when the decision model returns unusable output", async () => {
    const { env, ws } = makeClassifierEnv(() => ({ response: "nope" }));
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "images/pic.png",
      FITTING_PNG,
      "image/png",
    );
    expect(written).toEqual({ "ai.classifier": "failed", "ai.error": "no_answer" });
    const metaByKey = await getMetadataForKeys(env.DB, WORKSPACE, ["images/pic.png"]);
    expect(metaByKey.get("images/pic.png")?.["ai.classifier"]).toBe("failed");
  });

  it("does not wait out a hung call", async () => {
    const { env, ws, wasAborted } = makeClassifierEnv(() => DECIDED, {}, { hangUntilAbort: true });
    const started = Date.now();
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "images/pic.png",
      FITTING_PNG,
      "image/png",
      {
        timeoutMs: 20,
      },
    );
    expect(written).toEqual({ "ai.classifier": "failed", "ai.error": "timeout" });
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
      FITTING_PNG,
      "image/png",
      {
        run: async () => {
          throw new Error("boom");
        },
      },
    );
    expect(written).toEqual({ "ai.classifier": "failed", "ai.error": "provider_error" });
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
      atLeast(pngOf(400, 280)),
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
      FITTING_PNG,
      "image/png",
    );
    expect(written).toEqual({ "ai.classifier": "failed", "ai.error": "provider_error" });
  });

  it("aborts a hung model call after the resize has finished", async () => {
    const transform = recordingTransform(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return pngOf(1568, 980);
    });
    const { env, ws, calls, wasAborted } = makeClassifierEnv(
      () => DECIDED,
      {},
      { hangUntilAbort: true },
    );
    const started = Date.now();
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "shots/retina.png",
      atLeast(pngOf(2880, 1800)),
      "image/png",
      { transform, resizeTimeoutMs: 500, timeoutMs: 30 },
    );
    expect(transform.calls).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(stateImage(calls[0])?.type).toBe("image_url");
    expect(written).toEqual({ "ai.classifier": "failed", "ai.error": "timeout" });
    expect(wasAborted()).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
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

function recordingTransform(
  outputFor: (request: ClassifierResizeRequest) => Uint8Array | Promise<Uint8Array>,
): {
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
    expect(calls).toHaveLength(0);
    expect(written).toEqual({
      "ai.classifier": CLASSIFIER_SKIPPED,
      "ai.skip": CLASSIFIER_SKIP_UNSUPPORTED,
    });
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

  it("skips when the resize throws", async () => {
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
    expect(calls).toHaveLength(0);
    expect(written).toEqual({
      "ai.classifier": CLASSIFIER_SKIPPED,
      "ai.skip": CLASSIFIER_SKIP_RESIZE_FAILED,
    });
  });

  it("skips with resize_timeout when the resize hangs", async () => {
    const transform = recordingTransform(() => new Promise<Uint8Array>(() => {}));
    const { env, ws, calls } = makeClassifierEnv();
    const started = Date.now();
    const written = await classifyAndStore(
      env,
      ws,
      WORKSPACE,
      "shots/retina.png",
      atLeast(pngOf(2880, 1800)),
      "image/png",
      { transform, resizeTimeoutMs: 20 },
    );
    expect(calls).toHaveLength(0);
    expect(written).toEqual({
      "ai.classifier": CLASSIFIER_SKIPPED,
      "ai.skip": CLASSIFIER_SKIP_RESIZE_TIMEOUT,
    });
    expect(written?.["ai.kind"]).toBeUndefined();
    expect(written?.["ai.secret"]).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
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

  it("skips a text file and an oversized image", async () => {
    const { env, ws, calls } = lunaBase();
    const bytes = new TextEncoder().encode("export const n = 1;\n");
    const text = await classifyAndStore(env, ws, WORKSPACE, "src/n.ts", bytes, "text/plain");
    const big = new Uint8Array(CLASSIFIER_MAX_IMAGE_BYTES + 1);
    const oversized = await classifyAndStore(env, ws, WORKSPACE, "huge.png", big, "image/png");
    expect(calls).toHaveLength(0);
    expect(text).toEqual({
      "ai.classifier": CLASSIFIER_SKIPPED,
      "ai.skip": CLASSIFIER_SKIP_UNSUPPORTED,
    });
    expect(oversized).toEqual({
      "ai.classifier": CLASSIFIER_SKIPPED,
      "ai.skip": CLASSIFIER_SKIP_UNSUPPORTED,
    });
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
      "images/pic.png",
      FITTING_PNG,
      "image/png",
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

  it("skips a 64 px image that cannot enter Jev's window", async () => {
    const icon = atLeast(pngOf(CLASSIFIER_SKIP_MIN_EDGE, CLASSIFIER_SKIP_MIN_EDGE));
    expect(icon.byteLength).toBe(CLASSIFIER_SKIP_MIN_BYTES);
    const { env, ws, calls } = makeClassifierEnv();
    const written = await classifyAndStore(env, ws, WORKSPACE, "icons/app.png", icon, "image/png");
    expect(calls).toHaveLength(0);
    expect(written).toEqual({
      "ai.classifier": CLASSIFIER_SKIPPED,
      "ai.skip": CLASSIFIER_SKIP_UNSUPPORTED,
    });
  });

  it("skips unknown dimensions under 2 KiB, and skips a larger unmeasured file", async () => {
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
    expect(calls).toHaveLength(0);
    expect(written).toEqual({
      "ai.classifier": CLASSIFIER_SKIPPED,
      "ai.skip": CLASSIFIER_SKIP_RESIZE_FAILED,
    });
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
    const png = atLeast(pngOf(400, 280));
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
      "images/creds.png",
      FITTING_PNG,
      "image/png",
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
      "credential",
      "pii",
    ]);
    expect(written?.["ai.classifier"]).toBe(CLASSIFIER_LUNA_VERSION);
    expect(written?.["ai.secret"]).toBe("password");
    expect(written?.["ai.secret.confidence"]).toBe("medium");
    expect(written?.["ai.pii"]).toBe("contact");
    expect(written?.["ai.pii.confidence"]).toBe("medium");
  });

  it("replaces a stored safety flag only when the new answer is confident", async () => {
    let calls = 0;
    const { env, ws } = makeClassifierEnv(() => {
      calls += 1;
      if (calls === 1) return FLAGGED;
      return {
        answers: {
          secret: jevAnswer("none", 0.88),
          pii: jevAnswer("contact", 0.2),
        },
      };
    });
    const png = atLeast(pngOf(400, 280));
    const key = "images/flagged.png";
    await classifyAndStore(env, ws, WORKSPACE, key, png, "image/png");
    const written = await classifyAndStore(env, ws, WORKSPACE, key, png, "image/png");
    expect(written?.["ai.secret"]).toBe("none");
    expect(written?.["ai.pii"]).toBeUndefined();
    expect(written?.["ai.rating"]).toBeUndefined();

    const stored = (await getMetadataForKeys(env.DB, WORKSPACE, [key])).get(key);
    expect(stored?.["ai.secret"]).toBe("none");
    expect(stored?.["ai.secret.confidence"]).toBe("high");
    expect(stored?.["ai.pii"]).toBe("financial");
    expect(stored?.["ai.pii.confidence"]).toBe("medium");
    expect(stored?.["ai.rating"]).toBe("explicit");
    expect(stored?.["ai.content"]).toBe("sexual");
  });

  it("skips the model and keeps classifier rows when the same bytes are re-uploaded", async () => {
    let calls = 0;
    const harness = makeClassifierEnv(() => {
      calls += 1;
      if (calls === 1) return FLAGGED;
      throw new Error("provider down");
    });
    const png = atLeast(pngOf(400, 280));
    const first = await putFlagged(harness, png);
    const second = await putFlagged(harness, png, {
      replace: true,
      metadata: { path: "/settings", state: "after" },
    });

    expect(calls).toBe(1);
    expect(second.metadata).toEqual({ path: "/settings", state: "after" });
    const after = (await getMetadataForKeys(harness.env.DB, WORKSPACE, [first.key])).get(first.key);
    expect(after?.["ai.rating"]).toBe("explicit");
    expect(after?.["ai.rating.confidence"]).toBe("high");
    expect(after?.["ai.content"]).toBe("sexual");
    expect(after?.["ai.content.confidence"]).toBe("high");
    expect(after?.["ai.secret"]).toBe("api_key");
    expect(after?.["ai.secret.confidence"]).toBe("high");
    expect(after?.["ai.pii"]).toBe("financial");
    expect(after?.["ai.pii.confidence"]).toBe("medium");
    expect(after?.["ai.kind"]).toBe("screenshot");
    expect(after?.["ai.classifier"]).toBe("v5");
    expect(after?.["ai.error"]).toBeUndefined();
    expect(after?.path).toBe("/settings");
  });

  it("reuses a classification for identical bytes in the workspace, including safety flags", async () => {
    const harness = makeClassifierEnv(() => FLAGGED);
    const jpeg = jpegFrame(1);
    expect(jpeg.byteLength).toBeGreaterThanOrEqual(CLASSIFIER_SKIP_MIN_BYTES);
    const first = await putImage(harness, "images/exact-a.jpg", jpeg);
    const second = await putImage(harness, "images/exact-b.jpg", jpeg);

    expect(harness.calls).toHaveLength(1);
    const copied = (await getMetadataForKeys(harness.env.DB, WORKSPACE, [second.key])).get(
      second.key,
    );
    const original = (await getMetadataForKeys(harness.env.DB, WORKSPACE, [first.key])).get(
      first.key,
    );
    expect(copied?.["ai.classifier"]).toBe(CLASSIFIER_VERSION);
    expect(copied?.["ai.kind"]).toBe("screenshot");
    expect(copied?.["ai.secret"]).toBe("api_key");
    expect(copied?.["ai.secret.confidence"]).toBe("high");
    expect(copied?.["ai.pii"]).toBe("financial");
    expect(copied?.["ai.rating"]).toBe("explicit");
    expect(copied?.["ai.content"]).toBe("sexual");
    expect(copied?.["ai.phash"]).toBe(original?.["ai.phash"]);

    await putImage(harness, "images/exact-c.jpg", jpeg, "elsewhere");
    expect(harness.calls).toHaveLength(2);
  });

  it("reuses display labels on a pHash match and does not copy safety flags", async () => {
    const harness = makeClassifierEnv(() => FLAGGED);
    const original = jpegFrame(4);
    const resaved = jpegFrame(4, "re-saved");
    const different = jpegFrame(90);
    expect(original.byteLength).toBeGreaterThanOrEqual(CLASSIFIER_SKIP_MIN_BYTES);
    expect(Buffer.from(original).equals(Buffer.from(resaved))).toBe(false);

    const first = await putImage(harness, "images/phash-a.jpg", original);
    const second = await putImage(harness, "images/phash-b.jpg", resaved);
    expect(harness.calls).toHaveLength(1);

    const donor = (await getMetadataForKeys(harness.env.DB, WORKSPACE, [first.key])).get(first.key);
    const copied = (await getMetadataForKeys(harness.env.DB, WORKSPACE, [second.key])).get(
      second.key,
    );
    expect(copied?.["ai.phash"]).toBe(donor?.["ai.phash"]);
    expect(copied?.["ai.kind"]).toBe("screenshot");
    expect(copied?.["ai.surface"]).toBe("desktop");
    expect(copied?.["ai.screen"]).toBe("settings");
    expect(copied?.["ai.classifier"]).toBe(CLASSIFIER_VERSION);
    for (const key of [
      "ai.rating",
      "ai.rating.confidence",
      "ai.content",
      "ai.content.confidence",
      "ai.secret",
      "ai.secret.confidence",
      "ai.pii",
      "ai.pii.confidence",
      "ai.hold",
      "ai.hold.area",
    ]) {
      expect(copied?.[key]).toBeUndefined();
    }

    const third = await putImage(harness, "images/phash-c.jpg", different);
    expect(harness.calls).toHaveLength(2);
    const fresh = (await getMetadataForKeys(harness.env.DB, WORKSPACE, [third.key])).get(third.key);
    expect(fresh?.["ai.secret"]).toBe("api_key");
    expect(fresh?.["ai.phash"]).not.toBe(donor?.["ai.phash"]);
  });

  it("clears old labels when new bytes fail to classify, with or without metadata headers", async () => {
    for (const metadata of [undefined, { path: "/settings" }]) {
      let calls = 0;
      const harness = makeClassifierEnv(() => {
        calls += 1;
        if (calls === 1) return FLAGGED;
        throw new Error("provider down");
      });
      const first = await putFlagged(harness, atLeast(pngOf(400, 280)));
      await putFlagged(harness, atLeast(pngOf(512, 300)), { replace: true, metadata });

      const after = (await getMetadataForKeys(harness.env.DB, WORKSPACE, [first.key])).get(
        first.key,
      );
      expect(after?.["ai.kind"]).toBeUndefined();
      expect(after?.["ai.surface"]).toBeUndefined();
      expect(after?.["ai.screen"]).toBeUndefined();
      expect(after?.["ai.rating"]).toBeUndefined();
      expect(after?.["ai.classifier"]).toBe("failed");
      expect(after?.["ai.error"]).toBe("provider_error");
    }
  });

  it("does not keep a screen from old bytes when new bytes answer only some fields", async () => {
    let calls = 0;
    const harness = makeClassifierEnv(() => {
      calls += 1;
      if (calls === 1) return FLAGGED;
      return { ...DECIDED, answers: { kind: jevAnswer("photo") } };
    });
    const first = await putFlagged(harness, atLeast(pngOf(400, 280)));
    await putFlagged(harness, atLeast(pngOf(512, 300)), { replace: true });

    const after = (await getMetadataForKeys(harness.env.DB, WORKSPACE, [first.key])).get(first.key);
    expect(after?.["ai.kind"]).toBe("photo");
    expect(after?.["ai.screen"]).toBeUndefined();
    expect(after?.["ai.surface"]).toBeUndefined();
    expect(after?.["ai.classifier"]).toBe("v5");
  });

  it("replaces a failure marker once a retry on the same bytes succeeds", async () => {
    let calls = 0;
    const harness = makeClassifierEnv(() => {
      calls += 1;
      if (calls === 1) throw new Error("provider down");
      return DECIDED;
    });
    const png = atLeast(pngOf(400, 280));
    const first = await putFlagged(harness, png);
    expect(
      (await getMetadataForKeys(harness.env.DB, WORKSPACE, [first.key])).get(first.key)?.[
        "ai.classifier"
      ],
    ).toBe("failed");
    await putFlagged(harness, png, { replace: true });

    const after = (await getMetadataForKeys(harness.env.DB, WORKSPACE, [first.key])).get(first.key);
    expect(after?.["ai.classifier"]).toBe("v5");
    expect(after?.["ai.error"]).toBeUndefined();
    expect(after?.["ai.kind"]).toBe("screenshot");
  });

  it("removes safety flags when different bytes fail to reclassify, with or without metadata headers", async () => {
    const png = atLeast(pngOf(400, 280));
    const changed = atLeast(pngOf(500, 280));

    let headerCalls = 0;
    const withHeaders = makeClassifierEnv(() => {
      headerCalls += 1;
      if (headerCalls === 1) return FLAGGED;
      throw new Error("provider down");
    });
    await putFlagged(withHeaders, png, { metadata: { app: "web" } });
    await putFlagged(withHeaders, changed, { replace: true, metadata: { path: "/redacted" } });
    const replaced = (
      await getMetadataForKeys(withHeaders.env.DB, WORKSPACE, ["images/flagged.png"])
    ).get("images/flagged.png");
    expect(replaced?.["ai.secret"]).toBeUndefined();
    expect(replaced?.["ai.rating"]).toBeUndefined();
    expect(replaced?.["ai.pii"]).toBeUndefined();
    expect(replaced?.["ai.content"]).toBeUndefined();
    expect(replaced?.path).toBe("/redacted");
    expect(replaced?.app).toBeUndefined();

    let bareCalls = 0;
    const bare = makeClassifierEnv(() => {
      bareCalls += 1;
      if (bareCalls === 1) return FLAGGED;
      throw new Error("provider down");
    });
    await putFlagged(bare, png, { metadata: { app: "web" } });
    await putFlagged(bare, changed, { replace: true });
    const left = (await getMetadataForKeys(bare.env.DB, WORKSPACE, ["images/flagged.png"])).get(
      "images/flagged.png",
    );
    expect(left?.["ai.secret"]).toBeUndefined();
    expect(left?.["ai.secret.confidence"]).toBeUndefined();
    expect(left?.["ai.rating"]).toBeUndefined();
    expect(left?.["ai.pii"]).toBeUndefined();
    expect(left?.["ai.content"]).toBeUndefined();
    expect(left?.app).toBe("web");
  });

  it("stores the new safety flags when different bytes are reclassified", async () => {
    let calls = 0;
    const harness = makeClassifierEnv(() => {
      calls += 1;
      if (calls === 1) return FLAGGED;
      return {
        answers: {
          secret: jevAnswer("none", 0.93),
          pii: jevAnswer("none", 0.91),
          rating: jevAnswer("safe", 0.96),
          content: jevAnswer("none", 0.94),
        },
      };
    });
    await putFlagged(harness, atLeast(pngOf(400, 280)));
    await putFlagged(harness, atLeast(pngOf(500, 280)), {
      replace: true,
      metadata: { path: "/redacted" },
    });

    const stored = (
      await getMetadataForKeys(harness.env.DB, WORKSPACE, ["images/flagged.png"])
    ).get("images/flagged.png");
    expect(stored?.["ai.secret"]).toBe("none");
    expect(stored?.["ai.secret.confidence"]).toBe("high");
    expect(stored?.["ai.pii"]).toBe("none");
    expect(stored?.["ai.rating"]).toBe("safe");
    expect(stored?.["ai.content"]).toBe("none");
    expect(stored?.path).toBe("/redacted");
  });

  it("leaves safety flags cleared when new bytes are skipped", async () => {
    const png = atLeast(pngOf(400, 280));
    const skipped = atLeast(pngOf(100, 100));

    const withHeaders = makeClassifierEnv(() => FLAGGED);
    await putFlagged(withHeaders, png, { metadata: { app: "web" } });
    await putFlagged(withHeaders, skipped, { replace: true, metadata: { path: "/icon" } });
    const replaced = (
      await getMetadataForKeys(withHeaders.env.DB, WORKSPACE, ["images/flagged.png"])
    ).get("images/flagged.png");
    expect(withHeaders.calls).toHaveLength(1);
    expect(replaced?.["ai.classifier"]).toBe(CLASSIFIER_SKIPPED);
    expect(replaced?.["ai.skip"]).toBe(CLASSIFIER_SKIP_UNSUPPORTED);
    expect(replaced?.["ai.kind"]).toBeUndefined();
    expect(replaced?.["ai.surface"]).toBeUndefined();
    expect(replaced?.["ai.screen"]).toBeUndefined();
    expect(replaced?.["ai.secret"]).toBeUndefined();
    expect(replaced?.["ai.rating"]).toBeUndefined();
    expect(replaced?.["ai.content"]).toBeUndefined();
    expect(replaced?.["ai.pii"]).toBeUndefined();
    expect(replaced?.path).toBe("/icon");

    const bare = makeClassifierEnv(() => FLAGGED);
    await putFlagged(bare, png, { metadata: { app: "web" } });
    await putFlagged(bare, skipped, { replace: true });
    const left = (await getMetadataForKeys(bare.env.DB, WORKSPACE, ["images/flagged.png"])).get(
      "images/flagged.png",
    );
    expect(bare.calls).toHaveLength(1);
    expect(left?.["ai.classifier"]).toBe(CLASSIFIER_SKIPPED);
    expect(left?.["ai.skip"]).toBe(CLASSIFIER_SKIP_UNSUPPORTED);
    expect(left?.["ai.kind"]).toBeUndefined();
    expect(left?.["ai.surface"]).toBeUndefined();
    expect(left?.["ai.screen"]).toBeUndefined();
    expect(left?.["ai.secret"]).toBeUndefined();
    expect(left?.["ai.secret.confidence"]).toBeUndefined();
    expect(left?.["ai.rating"]).toBeUndefined();
    expect(left?.["ai.content"]).toBeUndefined();
    expect(left?.["ai.pii"]).toBeUndefined();
    expect(left?.app).toBe("web");
  });
});

describe("held uploads", () => {
  const key = "images/flagged.png";
  const holdOf = async (env: Env) =>
    (await getMetadataForKeys(env.DB, WORKSPACE, [key])).get(key)?.["ai.hold"];

  it("holds a file with a high-confidence secret", async () => {
    const { env, ws } = makeClassifierEnv(() => ({
      ...DECIDED,
      answers: { ...DECIDED.answers, secret: jevAnswer("api_key", 0.9) },
    }));
    await classifyAndStore(env, ws, WORKSPACE, key, FITTING_PNG, "image/png", {
      enforceHold: true,
    });
    expect(await holdOf(env)).toBe("pending");
  });

  it("stores where the flagged content is from a box call", async () => {
    let call = 0;
    const { env, ws, calls } = makeClassifierEnv(() =>
      call++ === 0
        ? FLAGGED
        : {
            answers: {
              area: {
                type: "box",
                box: { top: 0.2, bottom: 0.4, left: 0.1, right: 0.9 },
                confidence: 0.43,
              },
            },
          },
    );
    await classifyAndStore(env, ws, WORKSPACE, key, FITTING_PNG, "image/png", {
      enforceHold: true,
    });
    expect(await holdOf(env)).toBe("pending");
    expect(calls).toHaveLength(2);
    expect(calls[0].headers[DECISIONS_DANGER_ZONE_HEADER]).toBeUndefined();
    expect(calls[1].headers[DECISIONS_DANGER_ZONE_HEADER]).toBe("true");
    expect(calls[1].body.questions).toEqual({
      area: { type: "box", instructions: HOLD_AREA_INSTRUCTIONS.secret },
    });
    const stored = (await getMetadataForKeys(env.DB, WORKSPACE, [key])).get(key);
    expect(stored?.["ai.hold.area"]).toBe("0.170,0.430,0.070,0.930");
  });

  it("keeps the hold when the box call fails", async () => {
    let call = 0;
    const { env, ws } = makeClassifierEnv(() => {
      if (call++ === 0) return FLAGGED;
      throw new Error("box unavailable");
    });
    await classifyAndStore(env, ws, WORKSPACE, key, FITTING_PNG, "image/png", {
      enforceHold: true,
    });
    expect(await holdOf(env)).toBe("pending");
    const stored = (await getMetadataForKeys(env.DB, WORKSPACE, [key])).get(key);
    expect(stored?.["ai.hold.area"]).toBeUndefined();
  });

  it("holds a file with high-confidence financial data", async () => {
    const { env, ws } = makeClassifierEnv(() => ({
      ...DECIDED,
      answers: { ...DECIDED.answers, pii: jevAnswer("financial", 0.9) },
    }));
    await classifyAndStore(env, ws, WORKSPACE, key, FITTING_PNG, "image/png", {
      enforceHold: true,
    });
    expect(await holdOf(env)).toBe("pending");
  });

  it("does not hold contact details, medium confidence, or unsafe content", async () => {
    const { env, ws } = makeClassifierEnv(() => ({
      ...DECIDED,
      answers: {
        ...DECIDED.answers,
        rating: jevAnswer("explicit", 0.95),
        content: jevAnswer("gore", 0.95),
        secret: jevAnswer("token", 0.75),
        pii: jevAnswer("contact", 0.95),
      },
    }));
    await classifyAndStore(env, ws, WORKSPACE, key, FITTING_PNG, "image/png", {
      enforceHold: true,
    });
    expect(await holdOf(env)).toBeUndefined();
  });

  it("only logs a would-be hold for a client that cannot approve", async () => {
    const harness = makeClassifierEnv(() => FLAGGED);
    await putFlagged(harness, FITTING_PNG);
    expect(await holdOf(harness.env)).toBeUndefined();
    const stored = (await getMetadataForKeys(harness.env.DB, WORKSPACE, [key])).get(key);
    expect(stored?.["ai.secret"]).toBe("api_key");
  });

  it("does not hold when the operator kill switch is off", async () => {
    const { env, ws } = makeClassifierEnv(() => FLAGGED, {}, { holdFlag: false });
    await classifyAndStore(env, ws, WORKSPACE, key, FITTING_PNG, "image/png", {
      enforceHold: true,
    });
    expect(await holdOf(env)).toBeUndefined();
  });

  it("does not hold when the workspace turned holds off", async () => {
    const { env, ws } = makeClassifierEnv(() => FLAGGED, { holdFlaggedUploads: false });
    await classifyAndStore(env, ws, WORKSPACE, key, FITTING_PNG, "image/png", {
      enforceHold: true,
    });
    expect(await holdOf(env)).toBeUndefined();
  });

  it("keeps an approval when identical bytes are classified again", async () => {
    const harness = makeClassifierEnv(() => FLAGGED);
    await putFlagged(harness, FITTING_PNG, { enforceHold: true });
    expect(await holdOf(harness.env)).toBe("pending");

    const approved = await approveUpload(harness.env, harness.ws, WORKSPACE, key);
    expect(approved).toEqual({ approved: true });
    expect(await holdOf(harness.env)).toBe("approved");

    await putFlagged(harness, FITTING_PNG, { replace: true, enforceHold: true });
    expect(await holdOf(harness.env)).toBe("approved");
  });

  it("holds new bytes again after an approval", async () => {
    const harness = makeClassifierEnv(() => FLAGGED);
    await putFlagged(harness, FITTING_PNG, { enforceHold: true });
    await approveUpload(harness.env, harness.ws, WORKSPACE, key);

    await putFlagged(harness, atLeast(pngOf(512, 300)), { replace: true, enforceHold: true });
    expect(await holdOf(harness.env)).toBe("pending");
  });

  it("reports not_held for a file that is not held", async () => {
    const { env, ws } = makeClassifierEnv();
    await classifyAndStore(env, ws, WORKSPACE, key, FITTING_PNG, "image/png", {
      enforceHold: true,
    });
    expect(await approveUpload(env, ws, WORKSPACE, key)).toEqual({
      approved: false,
      reason: "not_held",
    });
    expect(await holdOf(env)).toBeUndefined();
  });
});

describe("held uploads move out of the public bucket", () => {
  const key = "images/flagged.png";
  const publicKey = `default/${key}`;
  const heldKey = `${WORKSPACE}/${key}`;

  function heldHarness(respond: () => unknown = () => FLAGGED) {
    const harness = makeClassifierEnv(respond);
    const held = new FakeR2Bucket();
    (harness.env as unknown as { UPLOADS_HELD: FakeR2Bucket }).UPLOADS_HELD = held;
    const publicBucket = (harness.env as unknown as { UPLOADS_DEFAULT: FakeR2Bucket })
      .UPLOADS_DEFAULT;
    return { ...harness, held, publicBucket };
  }
  const rows = async (env: Env) => (await getMetadataForKeys(env.DB, WORKSPACE, [key])).get(key);

  it("moves a held file into the held bucket and back on approval", async () => {
    const harness = heldHarness();
    await putFlagged(harness, FITTING_PNG, { enforceHold: true });

    expect(await harness.publicBucket.head(publicKey)).toBeNull();
    expect(await harness.held.head(heldKey)).not.toBeNull();
    expect((await rows(harness.env))?.["ai.hold.moved"]).toBe("1");

    expect(await approveUpload(harness.env, harness.ws, WORKSPACE, key)).toEqual({
      approved: true,
    });
    const restored = await harness.publicBucket.get(publicKey);
    expect(new Uint8Array(await restored!.arrayBuffer())).toEqual(FITTING_PNG);
    expect(await harness.held.head(heldKey)).toBeNull();
    const after = await rows(harness.env);
    expect(after?.["ai.hold"]).toBe("approved");
    expect(after?.["ai.hold.moved"]).toBeUndefined();
  });

  it("moves identical bytes straight back out when a held key is re-uploaded", async () => {
    const harness = heldHarness();
    await putFlagged(harness, FITTING_PNG, { enforceHold: true });
    await putFlagged(harness, FITTING_PNG, { replace: true, enforceHold: true });
    expect(await harness.publicBucket.head(publicKey)).toBeNull();
    expect(await harness.held.head(heldKey)).not.toBeNull();
  });

  it("drops the held copy when new bytes replace a held file", async () => {
    let calls = 0;
    const harness = heldHarness(() => (++calls === 1 ? FLAGGED : DECIDED));
    await putFlagged(harness, FITTING_PNG, { enforceHold: true });
    await putFlagged(harness, atLeast(pngOf(512, 300)), { replace: true, enforceHold: true });
    expect(await harness.held.head(heldKey)).toBeNull();
    expect(await harness.publicBucket.head(publicKey)).not.toBeNull();
    expect((await rows(harness.env))?.["ai.hold"]).toBeUndefined();
  });

  /** Records `/slack/internal/hold-resolved` calls on a fake SLACK binding. */
  function withSlack(env: Env) {
    const resolved: unknown[] = [];
    (env as unknown as { SLACK: Fetcher }).SLACK = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/slack/internal/hold-resolved")) {
          resolved.push(JSON.parse(String(init?.body)));
        }
        return new Response(null, { status: 204 });
      },
    } as unknown as Fetcher;
    return resolved;
  }

  it("tells Slack when a hold is approved or the held file is deleted", async () => {
    const approved = heldHarness();
    const approvedCalls = withSlack(approved.env);
    await putFlagged(approved, FITTING_PNG, { enforceHold: true });
    await approveUpload(approved.env, approved.ws, WORKSPACE, key, "Zach");
    expect(approvedCalls).toEqual([{ workspace: WORKSPACE, key, outcome: "approved", by: "Zach" }]);
    // Deleting it once approved has no hold left to report.
    await deleteObject(approved.env, approved.ws, key, WORKSPACE);
    expect(approvedCalls).toHaveLength(1);

    const deleted = heldHarness();
    const deletedCalls = withSlack(deleted.env);
    await putFlagged(deleted, FITTING_PNG, { enforceHold: true });
    await deleteObject(deleted.env, deleted.ws, key, WORKSPACE);
    expect(deletedCalls).toEqual([{ workspace: WORKSPACE, key, outcome: "deleted" }]);
  });

  it("deletes the held copy with the file", async () => {
    const harness = heldHarness();
    await putFlagged(harness, FITTING_PNG, { enforceHold: true });
    await deleteObject(harness.env, harness.ws, key, WORKSPACE);
    expect(await harness.held.head(heldKey)).toBeNull();
    expect(await rows(harness.env)).toBeUndefined();
  });
});
