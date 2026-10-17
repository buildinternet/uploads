import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLASSIFIER_DECISION_MODEL,
  CLASSIFIER_FLAG,
  CLASSIFIER_JEV_MODEL,
  CLASSIFIER_LUNA_FLAG,
  CLASSIFIER_LUNA_MODEL,
  CLASSIFIER_MAX_IMAGE_BYTES,
  JEV_MAX_IMAGE_EDGE,
  JEV_MAX_IMAGE_PIXELS,
  JEV_MIN_IMAGE_EDGE,
  JEV_MIN_IMAGE_PIXELS,
  OPENROUTER_DECISIONS_URL,
  buildClassifierQuestions,
  buildClassifierState,
  buildDecideRequest,
  buildDecisionImage,
  formatDecisionState,
  jevAcceptsDimensions,
  classificationAllowed,
  classifierEvaluationContext,
  classifierGatewayId,
  openRouterDecisionsRun,
  parseJevAnswers,
  resolveClassifierProvider,
  scheduleFileClassification,
  textExcerpt,
  workersAiClassifierRun,
  type DecisionImagePart,
} from "./classifier";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const flagsOn = { getBooleanValue: async () => true };
const flagsOff = { getBooleanValue: async (_k: string, def: boolean) => def };

function env(over: Record<string, unknown> = {}) {
  return {
    AI: { run: async () => ({ response: "{}" }) },
    FLAGS: flagsOn,
    AI_GATEWAY_ID: "uploads-classifier",
    OPENROUTER_API_KEY: "test-key",
    ...over,
  } as never as Env;
}

function pngOf(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return bytes;
}

/** SOF0 JPEG, 640×480. Small enough for Jev's pixel window. */
function jpeg640x480(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02,
    0x80, 0x03,
  ]);
}

/** VP8X WebP, 640×480. Luna can read it. Jev cannot. */
function webp640x480(): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46]);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  bytes[24] = 0x7f;
  bytes[25] = 0x02;
  bytes[27] = 0xdf;
  bytes[28] = 0x01;
  return bytes;
}

describe("classifierEvaluationContext", () => {
  it("uses WorkspaceRecord.name when set", () => {
    expect(classifierEvaluationContext({ name: "acme" }, "ignored")).toEqual({
      org: "acme",
      workspace: "acme",
    });
  });

  it("falls back to the putObject workspace name", () => {
    expect(classifierEvaluationContext({}, "demo")).toEqual({ org: "demo", workspace: "demo" });
    expect(classifierEvaluationContext({ name: "  " }, "demo")).toEqual({
      org: "demo",
      workspace: "demo",
    });
  });
});

describe("classificationAllowed", () => {
  it("allows when the OpenRouter key and Flagship are open, without a KV opt-in", async () => {
    expect(await classificationAllowed(env(), {}, "acme")).toBe(true);
    expect(await classificationAllowed(env(), { llmClassifierEnabled: true }, "acme")).toBe(true);
    expect(await classificationAllowed(env({ AI: undefined }), {}, "acme")).toBe(true);
  });

  it("denies when the workspace hard-off is set", async () => {
    expect(await classificationAllowed(env(), { llmClassifierEnabled: false }, "acme")).toBe(false);
  });

  it("denies when the OpenRouter key is missing or blank", async () => {
    expect(await classificationAllowed(env({ OPENROUTER_API_KEY: undefined }), {}, "acme")).toBe(
      false,
    );
    expect(await classificationAllowed(env({ OPENROUTER_API_KEY: "  " }), {}, "acme")).toBe(false);
  });

  it("fails closed when Flagship is missing, off, or throws", async () => {
    expect(await classificationAllowed(env({ FLAGS: undefined }), {}, "acme")).toBe(false);
    expect(await classificationAllowed(env({ FLAGS: flagsOff }), {}, "acme")).toBe(false);
    const flagsThrows = {
      getBooleanValue: async () => {
        throw new Error("flagship unreachable");
      },
    };
    expect(await classificationAllowed(env({ FLAGS: flagsThrows }), {}, "acme")).toBe(false);
  });

  it("evaluates Flagship with a closed default and { org, workspace } context", async () => {
    let seen: { name?: string; def?: boolean; context?: unknown } = {};
    const flags = {
      getBooleanValue: async (name: string, def: boolean, context?: unknown) => {
        seen = { name, def, context };
        return true;
      },
    };
    await classificationAllowed(env({ FLAGS: flags }), { name: "acme" }, "ignored");
    expect(seen).toEqual({
      name: CLASSIFIER_FLAG,
      def: false,
      context: { org: "acme", workspace: "acme" },
    });
    await classificationAllowed(env({ FLAGS: flags }), {}, "demo");
    expect(seen.context).toEqual({ org: "demo", workspace: "demo" });
  });

  it("does not evaluate Flagship when the key is missing or the hard-off is set", async () => {
    let called = false;
    const flags = {
      getBooleanValue: async () => {
        called = true;
        return true;
      },
    };
    expect(
      await classificationAllowed(env({ FLAGS: flags, OPENROUTER_API_KEY: undefined }), {}, "acme"),
    ).toBe(false);
    expect(
      await classificationAllowed(env({ FLAGS: flags }), { llmClassifierEnabled: false }, "acme"),
    ).toBe(false);
    expect(called).toBe(false);
  });
});

describe("resolveClassifierProvider", () => {
  it("defaults to jev when the provider is unset and the luna flag is off", async () => {
    expect(await resolveClassifierProvider(env({ FLAGS: flagsOff }), {}, "acme")).toBe("jev");
    expect(await resolveClassifierProvider(env({ FLAGS: undefined }), {}, "acme")).toBe("jev");
    expect(
      await resolveClassifierProvider(
        env({ CLASSIFIER_PROVIDER: "nope", FLAGS: flagsOff }),
        {},
        "acme",
      ),
    ).toBe("jev");
  });

  it("selects luna when the flag serves on for the workspace", async () => {
    let seen: { name?: string; def?: boolean; context?: unknown } = {};
    const flags = {
      getBooleanValue: async (name: string, def: boolean, context?: unknown) => {
        seen = { name, def, context };
        return name === CLASSIFIER_LUNA_FLAG;
      },
    };
    expect(
      await resolveClassifierProvider(env({ FLAGS: flags }), { name: "acme" }, "ignored"),
    ).toBe("luna");
    expect(seen).toEqual({
      name: CLASSIFIER_LUNA_FLAG,
      def: false,
      context: { org: "acme", workspace: "acme" },
    });
  });

  it("pins from CLASSIFIER_PROVIDER and does not read the flag", async () => {
    let called = false;
    const flags = {
      getBooleanValue: async () => {
        called = true;
        return true;
      },
    };
    expect(
      await resolveClassifierProvider(
        env({ FLAGS: flags, CLASSIFIER_PROVIDER: "luna" }),
        {},
        "acme",
      ),
    ).toBe("luna");
    expect(
      await resolveClassifierProvider(
        env({ FLAGS: flags, CLASSIFIER_PROVIDER: " JEV " }),
        {},
        "acme",
      ),
    ).toBe("jev");
    expect(called).toBe(false);
  });

  it("stays on jev when the luna flag throws", async () => {
    const flags = {
      getBooleanValue: async () => {
        throw new Error("flagship down");
      },
    };
    expect(await resolveClassifierProvider(env({ FLAGS: flags }), {}, "acme")).toBe("jev");
  });
});

describe("classifierGatewayId", () => {
  it("uses the wrangler var when set", () => {
    expect(classifierGatewayId(env({ AI_GATEWAY_ID: "my-gw" }))).toBe("my-gw");
  });

  it("falls back to uploads-classifier", () => {
    expect(classifierGatewayId(env({ AI_GATEWAY_ID: undefined }))).toBe("uploads-classifier");
    expect(classifierGatewayId(env({ AI_GATEWAY_ID: "  " }))).toBe("uploads-classifier");
  });
});

describe("buildClassifierState", () => {
  it("derives aspect from the image header", () => {
    expect(buildClassifierState("a.png", "image/png", pngOf(390, 844))).toMatchObject({
      filename: "a.png",
      content_type: "image/png",
      image_width: 390,
      image_height: 844,
      aspect: "portrait",
    });
    expect(buildClassifierState("a.png", "image/png", pngOf(1440, 900)).aspect).toBe("landscape");
    expect(buildClassifierState("a.png", "image/png", pngOf(512, 512)).aspect).toBe("square");
  });

  it("includes a text excerpt for text files and never raw bytes", () => {
    const bytes = new TextEncoder().encode("export function hello() { return 1; }\n");
    const state = buildClassifierState("src/hello.ts", "text/plain", bytes);
    expect(state.excerpt).toContain("export function hello");
    expect(state.byte_size).toBe(bytes.byteLength);
    expect(state.note).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain("base64");
  });

  it("notes an oversized image instead of sending it", () => {
    const big = new Uint8Array(CLASSIFIER_MAX_IMAGE_BYTES + 1);
    const state = buildClassifierState("huge.png", "image/png", big);
    expect(state.note).toContain("image skipped");
    expect(state.excerpt).toBeUndefined();
  });

  it("carries no excerpt for SVG or PDF", () => {
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    expect(buildClassifierState("icon.svg", "image/svg+xml", svg).excerpt).toBeUndefined();
    expect(
      buildClassifierState("notes.pdf", "application/pdf", new Uint8Array([1, 2, 3])).excerpt,
    ).toBeUndefined();
  });
});

describe("jevAcceptsDimensions", () => {
  it("accepts the inclusive pixel window", () => {
    expect(jevAcceptsDimensions(400, 256)).toBe(true);
    expect(jevAcceptsDimensions(1440, 900)).toBe(true);
    expect(jevAcceptsDimensions(280, 280)).toBe(true);
    expect(JEV_MIN_IMAGE_EDGE * JEV_MIN_IMAGE_EDGE).toBeLessThan(JEV_MIN_IMAGE_PIXELS);
    expect(jevAcceptsDimensions(JEV_MAX_IMAGE_EDGE, JEV_MAX_IMAGE_EDGE)).toBe(true);
    expect(JEV_MAX_IMAGE_EDGE * JEV_MAX_IMAGE_EDGE).toBe(JEV_MAX_IMAGE_PIXELS);
  });

  it("rejects an edge or a pixel count outside the window", () => {
    expect(jevAcceptsDimensions(JEV_MIN_IMAGE_EDGE, JEV_MIN_IMAGE_EDGE)).toBe(false);
    expect(jevAcceptsDimensions(100, 100)).toBe(false);
    expect(jevAcceptsDimensions(JEV_MAX_IMAGE_EDGE + 1, 900)).toBe(false);
    expect(jevAcceptsDimensions(1600, 900)).toBe(false);
  });
});

describe("buildDecisionImage", () => {
  it("sends a fitting PNG or JPEG to Jev as an image_url data URL", () => {
    const png = pngOf(400, 256);
    const pngImage = buildDecisionImage("jev", "image/png", png).image;
    expect(pngImage?.type).toBe("image_url");
    expect(pngImage?.image_url.url.startsWith("data:image/png;base64,")).toBe(true);
    const pngB64 = pngImage!.image_url.url.slice("data:image/png;base64,".length);
    expect(Uint8Array.from(Buffer.from(pngB64, "base64"))).toEqual(png);

    const jpeg = jpeg640x480();
    const jpegImage = buildDecisionImage("jev", "image/jpeg", jpeg).image;
    expect(jpegImage?.image_url.url.startsWith("data:image/jpeg;base64,")).toBe(true);
    const jpegB64 = jpegImage!.image_url.url.slice("data:image/jpeg;base64,".length);
    expect(Uint8Array.from(Buffer.from(jpegB64, "base64"))).toEqual(jpeg);
  });

  it("keeps a high byte in the data URL", () => {
    const bytes = new Uint8Array(pngOf(400, 256));
    bytes[10] = 0xff;
    const image = buildDecisionImage("jev", "image/png", bytes).image;
    const b64 = image!.image_url.url.slice("data:image/png;base64,".length);
    expect(Uint8Array.from(Buffer.from(b64, "base64"))[10]).toBe(0xff);
  });

  it("omits bytes Jev cannot take and says why", () => {
    expect(buildDecisionImage("jev", "image/png", pngOf(1600, 900))).toEqual({
      note: "image skipped: outside jev pixel limits",
    });
    expect(buildDecisionImage("jev", "image/webp", webp640x480()).note).toBe(
      "image skipped: jev accepts png and jpeg",
    );
    expect(buildDecisionImage("jev", "image/gif", pngOf(400, 256)).image).toBeUndefined();
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    expect(buildDecisionImage("jev", "image/svg+xml", svg).image).toBeUndefined();
    expect(buildDecisionImage("jev", "image/png", new Uint8Array()).image).toBeUndefined();
    expect(buildDecisionImage("jev", "image/png", new Uint8Array([0x89, 0x50])).note).toBe(
      "image skipped: dimensions unknown",
    );
    const big = new Uint8Array(CLASSIFIER_MAX_IMAGE_BYTES + 1);
    expect(buildDecisionImage("jev", "image/png", big).note).toContain("image skipped");
    expect(buildDecisionImage("jev", "text/plain", new TextEncoder().encode("hi"))).toEqual({});
  });

  it("lets Luna see WebP and a screenshot outside Jev's pixel window", () => {
    const wide = pngOf(1600, 900);
    expect(buildDecisionImage("luna", "image/png", wide).image?.type).toBe("image_url");
    const webp = buildDecisionImage("luna", "image/webp", webp640x480()).image;
    expect(webp?.image_url.url.startsWith("data:image/webp;base64,")).toBe(true);
    expect(buildDecisionImage("luna", "image/gif", pngOf(400, 256)).note).toBe(
      "image skipped: luna accepts png, jpeg, and webp",
    );
  });
});

describe("formatDecisionState", () => {
  it("puts facts in a string and the image part beside it", () => {
    const image: DecisionImagePart = {
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA" },
    };
    const state = formatDecisionState(
      {
        filename: "settings.png",
        content_type: "image/png",
        byte_size: 4,
        image_width: 400,
        image_height: 256,
        aspect: "landscape",
        note: "image skipped: outside jev pixel limits",
      },
      image,
    );
    expect(state).toHaveLength(2);
    expect(state[0]).toContain("filename: settings.png");
    expect(state[0]).toContain("aspect: landscape");
    expect(state[0]).toContain("outside jev pixel limits");
    expect(String(state[0])).not.toContain("base64");
    expect(state[1]).toEqual(image);
  });

  it("sends text files as a one-item array with the excerpt", () => {
    const state = formatDecisionState({
      filename: "notes.txt",
      content_type: "text/plain",
      byte_size: 5,
      excerpt: "hello",
    });
    expect(state).toEqual([
      "filename: notes.txt\ncontent_type: text/plain\nbyte_size: 5\nexcerpt: hello",
    ]);
  });
});

describe("buildDecideRequest", () => {
  it("asks Jev Latest the three closed-enum questions", () => {
    const bytes = pngOf(400, 256);
    const image = buildDecisionImage("jev", "image/png", bytes).image;
    const req = buildDecideRequest(buildClassifierState("a.png", "image/png", bytes), "jev", image);
    expect(req.stage).toBe("decide");
    expect(req.model).toBe(CLASSIFIER_JEV_MODEL);
    expect(req.image?.type).toBe("image_url");
    expect(Object.keys(req.questions)).toEqual(["kind", "surface", "screen"]);
    for (const question of Object.values(buildClassifierQuestions())) {
      expect(question.type).toBe("choice");
      expect(Object.keys(question.criteria).length).toBeGreaterThan(1);
    }
  });

  it("selects the Luna model without changing the questions", () => {
    const req = buildDecideRequest(
      buildClassifierState("a.png", "image/png", pngOf(400, 256)),
      "luna",
    );
    expect(req.model).toBe(CLASSIFIER_LUNA_MODEL);
    expect(Object.keys(req.questions)).toEqual(["kind", "surface", "screen"]);
  });
});

describe("openRouterDecisionsRun", () => {
  const image: DecisionImagePart = {
    type: "image_url",
    image_url: { url: "data:image/png;base64,AAAA" },
  };
  const req = buildDecideRequest(
    {
      filename: "a.png",
      content_type: "image/png",
      byte_size: 4,
      image_width: 400,
      image_height: 256,
      aspect: "landscape",
    },
    "jev",
    image,
  );

  it("posts the image to the Decisions URL with the bearer key", async () => {
    const calls: Array<{
      url: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        return new Response(
          JSON.stringify({
            answers: { kind: { type: "choice", choice: "photo", confidence: 0.9 } },
          }),
          { status: 200 },
        );
      }),
    );

    const run = openRouterDecisionsRun(env({ OPENROUTER_API_KEY: "secret-key" }));
    await expect(run(req)).resolves.toMatchObject({ answers: { kind: { choice: "photo" } } });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(OPENROUTER_DECISIONS_URL);
    expect(call.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(call.url).not.toContain("/api/v1/");
    expect(call.headers.Authorization).toBe("Bearer secret-key");
    expect(call.headers["Content-Type"]).toBe("application/json");
    expect(call.headers["HTTP-Referer"]).toBe("https://uploads.sh");
    expect(call.headers["X-Title"]).toBe("uploads");
    expect(call.body.model).toBe(CLASSIFIER_JEV_MODEL);
    const state = call.body.state as unknown[];
    expect(state[1]).toEqual(image);
    expect(String(state[0])).toContain("filename: a.png");
    expect(Object.keys(call.body.questions as object)).toEqual(["kind", "surface", "screen"]);
  });

  it("posts Luna to the same URL", async () => {
    let url = "";
    let model = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        url = String(input);
        model = (JSON.parse(String(init?.body ?? "{}")) as { model: string }).model;
        return new Response(JSON.stringify({ answers: {} }), { status: 200 });
      }),
    );
    const luna = buildDecideRequest(req.state, "luna", image);
    await openRouterDecisionsRun(env())(luna);
    expect(url).toBe(OPENROUTER_DECISIONS_URL);
    expect(model).toBe(CLASSIFIER_LUNA_MODEL);
  });

  it("throws when the key is missing or OpenRouter is not ok", async () => {
    await expect(openRouterDecisionsRun(env({ OPENROUTER_API_KEY: "  " }))(req)).rejects.toThrow(
      /OPENROUTER_API_KEY/,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 502 })),
    );
    await expect(openRouterDecisionsRun(env({ OPENROUTER_API_KEY: "k" }))(req)).rejects.toThrow(
      /502/,
    );
  });
});

describe("workersAiClassifierRun", () => {
  it("sends the digest decision to Workers AI and does not call OpenRouter", async () => {
    const calls: unknown[] = [];
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const run = workersAiClassifierRun(
      env({
        AI: {
          run: async (...args: unknown[]) => {
            calls.push(args);
            return { answers: { shot: { choice: "s0", confidence: 0.9 } } };
          },
        },
      }),
    );
    const request = buildDecideRequest(
      {
        filename: "weekly-digest",
        content_type: "text/plain",
        byte_size: 12,
        excerpt: "Screenshots",
      },
      "jev",
    );
    request.model = CLASSIFIER_DECISION_MODEL;
    await run(request);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    const [model, input, options] = calls[0] as [
      string,
      { state: { excerpt?: string } },
      { gateway?: { id?: string } },
    ];
    expect(model).toBe("typesafe/jev");
    expect(input.state.excerpt).toBe("Screenshots");
    expect(options.gateway?.id).toBe("uploads-classifier");
  });
});

describe("textExcerpt", () => {
  it("returns undefined for NUL-looking binary", () => {
    expect(textExcerpt(new Uint8Array([65, 0, 66]))).toBeUndefined();
  });

  it("strips non-ASCII and caps length", () => {
    const excerpt = textExcerpt(new TextEncoder().encode("café " + "a".repeat(2000)));
    expect(excerpt).toBeDefined();
    expect(excerpt!.includes("é")).toBe(false);
    expect(excerpt!.length).toBeLessThanOrEqual(1500);
  });
});

function answer(choice: string, confidence: number) {
  return { type: "choice", choice, confidence, probabilities: { [choice]: confidence } };
}

describe("parseJevAnswers", () => {
  it("accepts confident in-allowlist choices", () => {
    const parsed = parseJevAnswers({
      model: "jev-1.13.0",
      answers: {
        kind: answer("screenshot", 0.91),
        surface: answer("mobile", 0.82),
        screen: answer("login", 0.77),
      },
      usage: {},
    });
    expect(parsed?.meta).toEqual({
      "ai.kind": "screenshot",
      "ai.surface": "mobile",
      "ai.screen": "login",
    });
    expect(parsed?.confidences).toEqual({ kind: 0.91, surface: 0.82, screen: 0.77 });
  });

  it("drops answers under the confidence threshold but keeps the rest", () => {
    const parsed = parseJevAnswers({
      answers: { kind: answer("photo", 0.95), screen: answer("checkout", 0.21) },
    });
    expect(parsed?.meta).toEqual({ "ai.kind": "photo" });
    expect(parsed?.confidences.screen).toBe(0.21);
  });

  it("honours an explicit minConfidence", () => {
    const result = { answers: { kind: answer("photo", 0.6) } };
    expect(parseJevAnswers(result, { minConfidence: 0.9 })).toBeNull();
    expect(parseJevAnswers(result, { minConfidence: 0.5 })?.meta).toEqual({ "ai.kind": "photo" });
  });

  it("drops a choice that is not in the allowlist", () => {
    expect(
      parseJevAnswers({ answers: { kind: answer("nope", 0.99), surface: answer("desktop", 0.9) } })
        ?.meta,
    ).toEqual({ "ai.surface": "desktop" });
  });

  it("unwraps a wrapped payload", () => {
    expect(
      parseJevAnswers({ response: { answers: { kind: answer("diagram", 0.8) } } })?.meta,
    ).toEqual({ "ai.kind": "diagram" });
  });

  it("tolerates missing or garbage shapes", () => {
    expect(parseJevAnswers(null)).toBeNull();
    expect(parseJevAnswers("nope")).toBeNull();
    expect(parseJevAnswers({ answers: [] })).toBeNull();
    expect(parseJevAnswers({ answers: { kind: "screenshot" } })).toBeNull();
    expect(parseJevAnswers({ answers: { kind: { choice: "photo" } } })).toBeNull();
    expect(parseJevAnswers({ answers: { kind: answer("photo", Number.NaN) } })).toBeNull();
  });
});

describe("scheduleFileClassification", () => {
  it("is a no-op without waitUntil", () => {
    const run = vi.fn();
    scheduleFileClassification(
      env({ AI: { run } }),
      { provider: "r2", bucket: "b" },
      "acme",
      "f/x.png",
      new Uint8Array([1]),
      "image/png",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("hands the work to waitUntil and does not throw when waitUntil throws", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ answers: {} }), { status: 200 })),
    );
    expect(() =>
      scheduleFileClassification(
        env(),
        { provider: "r2", bucket: "b" },
        "acme",
        "f/x.png",
        new Uint8Array([1]),
        "image/png",
        () => {
          throw new Error("no ctx");
        },
      ),
    ).not.toThrow();
  });

  it("does not schedule when the key is missing or the hard-off is set", () => {
    const waitUntil = vi.fn();
    scheduleFileClassification(
      env({ OPENROUTER_API_KEY: "  " }),
      { provider: "r2", bucket: "b" },
      "acme",
      "f/x.png",
      new Uint8Array([1]),
      "image/png",
      waitUntil,
    );
    scheduleFileClassification(
      env(),
      { provider: "r2", bucket: "b", llmClassifierEnabled: false },
      "acme",
      "f/x.png",
      new Uint8Array([1]),
      "image/png",
      waitUntil,
    );
    expect(waitUntil).not.toHaveBeenCalled();
  });
});
