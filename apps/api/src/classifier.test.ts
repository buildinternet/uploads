import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLASSIFIER_DECISION_MODEL,
  CLASSIFIER_FLAG,
  CLASSIFIER_JEV_MODEL,
  CLASSIFIER_LUNA_FLAG,
  CLASSIFIER_LUNA_MODEL,
  CLASSIFIER_JPEG_QUALITIES,
  CLASSIFIER_MAX_IMAGE_BYTES,
  CLASSIFIER_SKIP_MIN_BYTES,
  CLASSIFIER_SKIP_MIN_EDGE,
  CLASSIFIER_SKIP_RESIZE_FAILED,
  CLASSIFIER_SKIP_SMALL,
  CLASSIFIER_SKIP_UNSUPPORTED,
  JEV_MAX_IMAGE_EDGE,
  JEV_MAX_IMAGE_PIXELS,
  JEV_MIN_IMAGE_EDGE,
  JEV_MIN_IMAGE_PIXELS,
  OPENROUTER_DECISIONS_URL,
  CLASSIFIER_CONFIDENCE_HIGH,
  CLASSIFIER_CONFIDENCE_MEDIUM,
  CLASSIFIER_MIN_CONFIDENCE,
  buildClassifierQuestions,
  buildClassifierState,
  buildDecideRequest,
  buildDecisionImage,
  classifierResizeAttempts,
  encodeForJevWindow,
  formatDecisionState,
  imagesClassifierTransform,
  jevAcceptsDimensions,
  jevScaleDownFit,
  jevUnfittableNote,
  prepareClassifierImage,
  type ClassifierImageTransform,
  type ClassifierResizeRequest,
  classificationAllowed,
  classifierEvaluationContext,
  classifierGatewayId,
  openRouterDecisionsRun,
  parseJevAnswers,
  resolveClassifierProvider,
  scheduleFileClassification,
  trivialImageSkip,
  workersAiClassifierRun,
  type DecisionImagePart,
  CONTENT_CRITERIA,
  PII_CRITERIA,
  RATING_CRITERIA,
  SECRET_CRITERIA,
  confidenceBucket,
} from "./classifier";
import {
  CLASSIFIER_CLEAN_VALUES,
  CLASSIFIER_SAFETY_FIELDS,
  isConfidenceBucket,
} from "./classifier-admin-wire";
import { SAFETY_FLAG_FIELDS } from "./file-metadata";

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

function atLeast(bytes: Uint8Array, min: number): Uint8Array {
  if (bytes.byteLength >= min) return bytes;
  const out = new Uint8Array(min);
  out.set(bytes);
  return out;
}

/** SOF0 JPEG, 640×480. Small enough for Jev's pixel window. */
function jpeg640x480(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02,
    0x80, 0x03,
  ]);
}

/** SOF0 JPEG of the given size. The segment lengths match the small fixture above. */
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
    expect(
      await classificationAllowed(env({ FLAGS: flags }), { classifyUploads: false }, "acme"),
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
});

describe("trivialImageSkip", () => {
  const floor = CLASSIFIER_SKIP_MIN_BYTES;
  const edge = CLASSIFIER_SKIP_MIN_EDGE;

  it("skips an image under 64 px or under 2 KiB", () => {
    expect(trivialImageSkip("image/png", pngOf(1, 1))).toBe(CLASSIFIER_SKIP_SMALL);
    expect(trivialImageSkip("image/png", atLeast(pngOf(edge - 1, edge - 1), floor))).toBe(
      CLASSIFIER_SKIP_SMALL,
    );
    expect(trivialImageSkip("image/png", atLeast(pngOf(32, 400), floor))).toBe(
      CLASSIFIER_SKIP_SMALL,
    );
    expect(trivialImageSkip("image/png", atLeast(pngOf(400, 280), floor - 1))).toBe(
      CLASSIFIER_SKIP_SMALL,
    );
    expect(
      trivialImageSkip(
        "image/png",
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe(CLASSIFIER_SKIP_SMALL);
  });

  it("keeps a 64 px image of exactly 2 KiB, an unmeasured file at that size, and non-images", () => {
    expect(trivialImageSkip("image/png", atLeast(pngOf(edge, edge), floor))).toBeUndefined();
    expect(trivialImageSkip("image/png", atLeast(pngOf(400, edge), floor))).toBeUndefined();
    const unknown = atLeast(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      floor,
    );
    expect(unknown.byteLength).toBe(floor);
    expect(trivialImageSkip("image/png", unknown)).toBeUndefined();
    expect(trivialImageSkip("text/plain", new TextEncoder().encode("hi"))).toBeUndefined();
    expect(trivialImageSkip("video/mp4", new Uint8Array(8))).toBeUndefined();
  });
});

describe("jevAcceptsDimensions", () => {
  it("accepts the inclusive pixel window", () => {
    expect(jevAcceptsDimensions(400, 280)).toBe(true);
    expect(jevAcceptsDimensions(1440, 900)).toBe(true);
    expect(jevAcceptsDimensions(280, 280)).toBe(true);
    expect(JEV_MIN_IMAGE_EDGE * JEV_MIN_IMAGE_EDGE).toBe(JEV_MIN_IMAGE_PIXELS);
    expect(jevAcceptsDimensions(JEV_MAX_IMAGE_EDGE, JEV_MAX_IMAGE_EDGE)).toBe(true);
    expect(JEV_MAX_IMAGE_EDGE * JEV_MAX_IMAGE_EDGE).toBe(JEV_MAX_IMAGE_PIXELS);
  });

  it("rejects an edge or a pixel count outside the window", () => {
    expect(jevAcceptsDimensions(JEV_MIN_IMAGE_EDGE - 1, 900)).toBe(false);
    // Jev 1.14 answers "Invalid image dimensions" for a 270 px side.
    expect(jevAcceptsDimensions(1200, 260)).toBe(false);
    expect(jevAcceptsDimensions(100, 100)).toBe(false);
    expect(jevAcceptsDimensions(JEV_MAX_IMAGE_EDGE + 1, 900)).toBe(false);
    expect(jevAcceptsDimensions(1600, 900)).toBe(false);
  });
});

describe("buildDecisionImage", () => {
  it("sends a fitting PNG or JPEG to Jev as an image_url data URL", () => {
    const png = pngOf(400, 280);
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
    const bytes = new Uint8Array(pngOf(400, 280));
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
    expect(buildDecisionImage("jev", "image/gif", pngOf(400, 280)).image).toBeUndefined();
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
    expect(buildDecisionImage("luna", "image/gif", pngOf(400, 280)).note).toBe(
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
        image_height: 280,
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
});

describe("buildDecideRequest", () => {
  const QUESTION_IDS = [
    "kind",
    "surface",
    "screen",
    "ready",
    "rating",
    "content",
    "secret",
    "credential",
    "pii",
  ];

  it("asks Jev Latest every closed question in one request", () => {
    const bytes = pngOf(400, 280);
    const image = buildDecisionImage("jev", "image/png", bytes).image;
    const req = buildDecideRequest(buildClassifierState("a.png", "image/png", bytes), "jev", image);
    expect(req.stage).toBe("decide");
    expect(req.model).toBe(CLASSIFIER_JEV_MODEL);
    expect(req.image?.type).toBe("image_url");
    expect(Object.keys(req.questions)).toEqual(QUESTION_IDS);
    for (const question of Object.values(req.questions)) {
      if (question.type !== "choice") throw new Error("expected a choice question");
      const options = Object.keys(question.criteria).length;
      expect(options).toBeGreaterThanOrEqual(2);
      expect(options).toBeLessThanOrEqual(255);
    }
    // TypeSafe documents no question-count cap (token budget only). Nine
    // short choices stay far inside that budget and inside the 255-option cap.
    expect(QUESTION_IDS.length).toBe(9);
    expect(Object.keys(buildClassifierQuestions().screen.criteria).length).toBeLessThanOrEqual(255);
  });

  it("keeps secrets and personal data on separate questions", () => {
    const questions = buildClassifierQuestions();
    expect(questions.secret.instructions).toMatch(/email/i);
    expect(questions.secret.instructions).toMatch(/personal data/i);
    expect(questions.pii.instructions).toMatch(/header/i);
    expect(questions.pii.instructions).toMatch(/credential/i);
    expect(Object.keys(questions.secret.criteria)).not.toContain("contact");
    expect(Object.keys(questions.secret.criteria)).not.toContain("email");
    expect(Object.keys(questions.pii.criteria)).not.toContain("api_key");
    expect(Object.keys(questions.pii.criteria)).not.toContain("password");
    expect(questions.pii.criteria.none).toMatch(/header/i);
    expect(questions.secret.criteria.none).toMatch(/email/i);
  });

  it("selects the Luna model without changing the questions", () => {
    const req = buildDecideRequest(
      buildClassifierState("a.png", "image/png", pngOf(400, 280)),
      "luna",
    );
    expect(req.model).toBe(CLASSIFIER_LUNA_MODEL);
    expect(Object.keys(req.questions)).toEqual(QUESTION_IDS);
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
      image_height: 280,
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
    expect(Object.keys(call.body.questions as object)).toEqual([
      "kind",
      "surface",
      "screen",
      "ready",
      "rating",
      "content",
      "secret",
      "credential",
      "pii",
    ]);
    const state = call.body.state as unknown[];
    expect(state[1]).toEqual(image);
    expect(String(state[0])).toContain("filename: a.png");
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

  it("holds on the yes/no credential answer when the typed answer splits", () => {
    // Several kinds of credential split the typed answer under the floor.
    expect(
      parseJevAnswers({
        answers: { secret: answer("api_key", 0.4), credential: answer("yes", 0.93) },
      })?.meta,
    ).toEqual({ "ai.secret": "other", "ai.secret.confidence": "high" });
    expect(
      parseJevAnswers({
        answers: { secret: answer("token", 0.8), credential: answer("yes", 0.75) },
      })?.meta,
    ).toEqual({ "ai.secret": "token", "ai.secret.confidence": "medium" });
    expect(
      parseJevAnswers({
        answers: { secret: answer("api_key", 0.6), credential: answer("no", 0.9) },
      })?.meta,
    ).toEqual({ "ai.secret": "none", "ai.secret.confidence": "high" });
    // An unsure credential answer leaves the typed answer alone.
    expect(
      parseJevAnswers({
        answers: { secret: answer("password", 0.95), credential: answer("yes", 0.3) },
      })?.meta,
    ).toEqual({ "ai.secret": "password", "ai.secret.confidence": "high" });
  });

  it("writes safety flags and confidence buckets without mixing secret and pii", () => {
    const parsed = parseJevAnswers({
      answers: {
        kind: answer("screenshot", 0.99),
        rating: answer("suggestive", CLASSIFIER_CONFIDENCE_HIGH),
        content: answer("sexual", 0.72),
        secret: answer("api_key", 0.91),
        pii: answer("none", 0.61),
      },
    });
    expect(parsed?.meta).toEqual({
      "ai.kind": "screenshot",
      "ai.rating": "suggestive",
      "ai.rating.confidence": "high",
      "ai.content": "sexual",
      "ai.content.confidence": "medium",
      "ai.secret": "api_key",
      "ai.secret.confidence": "high",
      "ai.pii": "none",
      "ai.pii.confidence": "low",
    });
    expect(parsed?.meta["ai.kind.confidence"]).toBeUndefined();

    const personal = parseJevAnswers({
      answers: {
        secret: answer("email", 0.99),
        pii: answer("contact", 0.8),
      },
    });
    expect(personal?.meta).toEqual({
      "ai.pii": "contact",
      "ai.pii.confidence": "medium",
    });

    const credential = parseJevAnswers({
      answers: {
        secret: answer("password", 0.95),
        pii: answer("api_key", 0.95),
      },
    });
    expect(credential?.meta).toEqual({
      "ai.secret": "password",
      "ai.secret.confidence": "high",
    });
  });

  it("buckets confidence at the documented bounds and drops the rest", () => {
    const at = (confidence: number) =>
      parseJevAnswers({ answers: { secret: answer("token", confidence) } })?.meta?.[
        "ai.secret.confidence"
      ];
    expect(at(CLASSIFIER_CONFIDENCE_HIGH)).toBe("high");
    expect(at(CLASSIFIER_CONFIDENCE_HIGH - 0.001)).toBe("medium");
    expect(at(CLASSIFIER_CONFIDENCE_MEDIUM)).toBe("medium");
    expect(at(CLASSIFIER_CONFIDENCE_MEDIUM - 0.001)).toBe("low");
    expect(at(CLASSIFIER_MIN_CONFIDENCE)).toBe("low");
    expect(at(CLASSIFIER_MIN_CONFIDENCE - 0.001)).toBeUndefined();
    expect(
      parseJevAnswers({
        answers: { secret: answer("token", CLASSIFIER_MIN_CONFIDENCE - 0.001) },
      }),
    ).toBeNull();
  });
});

describe("jevScaleDownFit", () => {
  it("fits the longest side inside the window and does not upscale", () => {
    expect(jevScaleDownFit(2880, 1800)).toEqual({ width: 1568, height: 980 });
    expect(jevScaleDownFit(1600, 900)).toEqual({ width: 1568, height: 882 });
    expect(jevScaleDownFit(400, 280)).toEqual({ width: 400, height: 280 });
    expect(jevScaleDownFit(100, 100)).toBeUndefined();
    expect(jevScaleDownFit(8000, 100)).toBeUndefined();
    expect(jevUnfittableNote(100, 100)).toBe("image skipped: below jev pixel limits");
    expect(jevUnfittableNote(8000, 100)).toBe("image skipped: outside jev pixel limits");
  });
});

describe("classifierResizeAttempts", () => {
  it("tries a PNG first for a PNG upload, then two JPEG qualities", () => {
    const attempts = classifierResizeAttempts("image/png");
    expect(attempts.map((attempt) => attempt.format)).toEqual([
      "image/png",
      "image/jpeg",
      "image/jpeg",
    ]);
    expect(attempts[1]?.quality).toBe(CLASSIFIER_JPEG_QUALITIES[0]);
    expect(attempts[2]?.quality).toBe(CLASSIFIER_JPEG_QUALITIES[1]);
    expect(attempts.every((attempt) => attempt.fit === "scale-down")).toBe(true);
    expect(attempts.every((attempt) => attempt.width === JEV_MAX_IMAGE_EDGE)).toBe(true);
    expect(attempts.every((attempt) => attempt.height === JEV_MAX_IMAGE_EDGE)).toBe(true);
  });

  it("encodes WebP, GIF, and AVIF as JPEG only", () => {
    for (const type of ["image/webp", "image/gif", "image/avif"]) {
      const attempts = classifierResizeAttempts(type);
      expect(attempts.map((attempt) => attempt.format)).toEqual(["image/jpeg", "image/jpeg"]);
    }
  });
});

function recordingTransform(
  respond: (request: ClassifierResizeRequest) => Uint8Array | Promise<Uint8Array>,
): { transform: ClassifierImageTransform; calls: ClassifierResizeRequest[] } {
  const calls: ClassifierResizeRequest[] = [];
  return {
    calls,
    transform: {
      async resize(_bytes, request) {
        calls.push(request);
        return respond(request);
      },
    },
  };
}

describe("prepareClassifierImage", () => {
  it("sends a fitting PNG through unchanged", async () => {
    const png = pngOf(400, 280);
    const { transform, calls } = recordingTransform(() => {
      throw new Error("should not resize");
    });
    const prepared = await prepareClassifierImage("jev", "image/png", png, transform);
    expect(calls).toHaveLength(0);
    expect(prepared.resized).toBe(false);
    expect(prepared.note).toBeUndefined();
    expect(prepared.image?.image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("does not upscale an undersized image", async () => {
    const { transform, calls } = recordingTransform(() => pngOf(280, 280));
    const prepared = await prepareClassifierImage("jev", "image/png", pngOf(100, 100), transform);
    expect(calls).toHaveLength(0);
    expect(prepared.image).toBeUndefined();
    expect(prepared.resized).toBe(false);
    expect(prepared.note).toBe("image skipped: below jev pixel limits");
    expect(prepared.skip).toBe(CLASSIFIER_SKIP_UNSUPPORTED);
  });

  it("skips an extreme aspect ratio instead of resizing", async () => {
    const { transform, calls } = recordingTransform(() => pngOf(280, 280));
    const prepared = await prepareClassifierImage("jev", "image/png", pngOf(8000, 100), transform);
    expect(calls).toHaveLength(0);
    expect(prepared.image).toBeUndefined();
    expect(prepared.note).toBe("image skipped: outside jev pixel limits");
    expect(prepared.skip).toBe(CLASSIFIER_SKIP_UNSUPPORTED);
  });

  it("does not send an SVG to the transform", async () => {
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    const { transform, calls } = recordingTransform(() => pngOf(280, 280));
    const prepared = await prepareClassifierImage("jev", "image/svg+xml", svg, transform);
    expect(calls).toHaveLength(0);
    expect(prepared.image).toBeUndefined();
    expect(prepared.resized).toBe(false);
    expect(prepared.note).toBe("image skipped: jev accepts png and jpeg");
    expect(prepared.skip).toBe(CLASSIFIER_SKIP_UNSUPPORTED);
  });

  it("falls back when the transform throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { transform } = recordingTransform(() => {
      throw new Error("images down");
    });
    const prepared = await prepareClassifierImage("jev", "image/png", pngOf(2880, 1800), transform);
    expect(prepared.image).toBeUndefined();
    expect(prepared.resized).toBe(false);
    expect(prepared.note).toBe("image skipped: transform failed");
    expect(prepared.skip).toBe(CLASSIFIER_SKIP_RESIZE_FAILED);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "classifier_image_transform_failed" }),
    );
  });

  it("says when the binding is missing", async () => {
    const prepared = await prepareClassifierImage("jev", "image/webp", webp640x480(), undefined);
    expect(prepared.note).toBe("image skipped: transform unavailable");
    expect(prepared.image).toBeUndefined();
    expect(prepared.skip).toBe(CLASSIFIER_SKIP_RESIZE_FAILED);
  });

  it("drops to JPEG when the PNG copy is over the byte cap", async () => {
    const over = new Uint8Array(CLASSIFIER_MAX_IMAGE_BYTES + 1);
    over.set(pngOf(1568, 980));
    const jpeg = jpegOf(1568, 980);
    const { transform, calls } = recordingTransform((request) =>
      request.format === "image/png" ? over : jpeg,
    );
    const encoded = await encodeForJevWindow(transform, pngOf(2880, 1800), "image/png");
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.contentType).toBe("image/jpeg");
    expect(encoded.width).toBe(1568);
    expect(encoded.height).toBe(980);
    expect(calls.map((call) => call.format)).toEqual(["image/png", "image/jpeg"]);
    expect(calls[1]?.quality).toBe(82);
  });

  it("does not resize Luna", async () => {
    const wide = pngOf(1600, 900);
    const { transform, calls } = recordingTransform(() => {
      throw new Error("should not resize");
    });
    const prepared = await prepareClassifierImage("luna", "image/png", wide, transform);
    expect(calls).toHaveLength(0);
    expect(prepared.resized).toBe(false);
    expect(prepared.image?.image_url.url.startsWith("data:image/png;base64,")).toBe(true);
    const webp = await prepareClassifierImage("luna", "image/webp", webp640x480(), transform);
    expect(webp.image?.image_url.url.startsWith("data:image/webp;base64,")).toBe(true);
    expect(calls).toHaveLength(0);
    const gif = await prepareClassifierImage("luna", "image/gif", pngOf(400, 280), transform);
    expect(gif.image).toBeUndefined();
    expect(gif.skip).toBe(CLASSIFIER_SKIP_UNSUPPORTED);
  });
});

describe("imagesClassifierTransform", () => {
  it("asks the Images binding for a still inside the Jev box", async () => {
    const source = pngOf(2880, 1800);
    const produced = jpegOf(1568, 980);
    const calls: Array<{
      transform: { width?: number; height?: number; fit?: string };
      output: { format?: string; quality?: number; anim?: boolean };
      received: Uint8Array;
    }> = [];
    const binding = {
      input(stream: ReadableStream<Uint8Array>) {
        const pending = new Response(stream).arrayBuffer();
        return {
          transform(transform: { width?: number; height?: number; fit?: string }) {
            return {
              output(options: { format?: string; quality?: number; anim?: boolean }) {
                return pending.then((buf) => {
                  calls.push({ transform, output: options, received: new Uint8Array(buf) });
                  return {
                    contentType: () => options.format ?? "image/jpeg",
                    response: () => new Response(produced),
                    image: () =>
                      new ReadableStream<Uint8Array>({
                        start(controller) {
                          controller.enqueue(produced);
                          controller.close();
                        },
                      }),
                  };
                });
              },
            };
          },
        };
      },
    } as unknown as ImagesBinding;

    const out = await imagesClassifierTransform(binding).resize(source, {
      width: JEV_MAX_IMAGE_EDGE,
      height: JEV_MAX_IMAGE_EDGE,
      fit: "scale-down",
      format: "image/jpeg",
      quality: 82,
    });
    expect(out).toEqual(produced);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.received).toEqual(source);
    expect(calls[0]?.transform).toEqual({
      width: JEV_MAX_IMAGE_EDGE,
      height: JEV_MAX_IMAGE_EDGE,
      fit: "scale-down",
    });
    expect(calls[0]?.output).toEqual({ format: "image/jpeg", quality: 82, anim: false });
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

describe("classifier admin vocabulary", () => {
  it("names a clean value the classifier can actually write for each safety field", () => {
    const criteria = {
      rating: RATING_CRITERIA,
      content: CONTENT_CRITERIA,
      secret: SECRET_CRITERIA,
      pii: PII_CRITERIA,
    };
    expect([...SAFETY_FLAG_FIELDS]).toEqual(Object.keys(criteria));
    for (const field of CLASSIFIER_SAFETY_FIELDS) {
      expect(Object.keys(criteria[field])).toContain(CLASSIFIER_CLEAN_VALUES[field]);
    }
  });

  it("covers every confidence bucket the classifier writes", () => {
    for (const confidence of [0.5, 0.7, 0.85, 1]) {
      expect(isConfidenceBucket(confidenceBucket(confidence))).toBe(true);
    }
  });
});
