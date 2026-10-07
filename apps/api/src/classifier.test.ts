import { describe, expect, it, vi } from "vitest";
import {
  CLASSIFIER_DECISION_MODEL,
  CLASSIFIER_FLAG,
  CLASSIFIER_LUNA_FLAG,
  CLASSIFIER_LUNA_MODEL,
  CLASSIFIER_MAX_IMAGE_BYTES,
  CLASSIFIER_VISION_MODEL,
  OPENROUTER_DECISIONS_ENDPOINT,
  buildClassifierQuestions,
  buildClassifierState,
  buildDecideRequest,
  buildDescribeRequest,
  buildLunaDecideRequest,
  buildLunaDecisionState,
  classificationAllowed,
  classifierEvaluationContext,
  classifierGatewayId,
  extractJsonObject,
  extractModelText,
  openRouterLunaClassifierRun,
  parseDescribeOutput,
  parseJevAnswers,
  resolveClassifierProvider,
  scheduleFileClassification,
  textExcerpt,
} from "./classifier";

const flagsOn = { getBooleanValue: async () => true };
const flagsOff = { getBooleanValue: async (_k: string, def: boolean) => def };

function env(over: Record<string, unknown> = {}) {
  return {
    AI: { run: async () => ({ response: "{}" }) },
    FLAGS: flagsOn,
    AI_GATEWAY_ID: "uploads-classifier",
    ...over,
  } as never as Env;
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
  it("allows when AI and Flagship are open, without a KV opt-in", async () => {
    expect(await classificationAllowed(env(), {}, "acme")).toBe(true);
    expect(await classificationAllowed(env(), { llmClassifierEnabled: true }, "acme")).toBe(true);
  });

  it("denies when the workspace hard-off is set", async () => {
    expect(await classificationAllowed(env(), { llmClassifierEnabled: false }, "acme")).toBe(false);
  });

  it("denies when the AI binding is absent", async () => {
    expect(await classificationAllowed(env({ AI: undefined }), {}, "acme")).toBe(false);
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

  it("does not evaluate Flagship when the workspace hard-off is set", async () => {
    let called = false;
    const flags = {
      getBooleanValue: async () => {
        called = true;
        return true;
      },
    };
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

describe("buildDescribeRequest", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("sends raster images under the cap to the vision model", () => {
    const req = buildDescribeRequest("screenshots/settings.png", "image/png", png);
    expect(req?.stage).toBe("describe");
    expect(req?.model).toBe(CLASSIFIER_VISION_MODEL);
    expect(req?.image).toBe(png);
    expect(req?.prompt).toContain("filename: settings.png");
    expect(req?.prompt).toContain("content-type: image/png");
  });

  it("skips stage 1 for oversized images, SVG, text, and PDF", () => {
    const big = new Uint8Array(CLASSIFIER_MAX_IMAGE_BYTES + 1);
    expect(buildDescribeRequest("huge.png", "image/png", big)).toBeUndefined();
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    expect(buildDescribeRequest("icon.svg", "image/svg+xml", svg)).toBeUndefined();
    const text = new TextEncoder().encode("hello");
    expect(buildDescribeRequest("a.txt", "text/plain", text)).toBeUndefined();
    expect(buildDescribeRequest("notes.pdf", "application/pdf", text)).toBeUndefined();
  });
});

function pngOf(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return bytes;
}

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

  it("folds stage 1's description, tags, and summary in", () => {
    const state = buildClassifierState("a.png", "image/png", pngOf(1440, 900), {
      description: "A settings page with a sidebar.",
      tags: ["ui", "settings"],
      summary: "Settings",
    });
    expect(state.description).toBe("A settings page with a sidebar.");
    expect(state.tags).toEqual(["ui", "settings"]);
    expect(state.summary).toBe("Settings");
  });
});

describe("buildLunaDecisionState", () => {
  it("sends filename, type, size, dimensions, and an inline image", () => {
    const png = pngOf(1440, 900);
    const state = buildLunaDecisionState("screenshots/settings.png", "image/png", png);
    expect(state).toMatchObject({
      filename: "settings.png",
      content_type: "image/png",
      byte_size: png.byteLength,
      image_width: 1440,
      image_height: 900,
      aspect: "landscape",
    });
    expect(state.image?.type).toBe("input_image");
    expect(state.image?.image_url.startsWith("data:image/png;base64,")).toBe(true);
    const b64 = state.image!.image_url.slice("data:image/png;base64,".length);
    expect(Uint8Array.from(Buffer.from(b64, "base64"))).toEqual(png);
    expect(state.description).toBeUndefined();
  });

  it("keeps a high byte in the data URL", () => {
    const bytes = new Uint8Array(pngOf(8, 8));
    bytes[10] = 0xff;
    const state = buildLunaDecisionState("a.png", "image/png", bytes);
    const b64 = state.image!.image_url.slice("data:image/png;base64,".length);
    expect(Uint8Array.from(Buffer.from(b64, "base64"))[10]).toBe(0xff);
  });

  it("omits the image for text, SVG, empty, and oversized rasters", () => {
    const text = new TextEncoder().encode("hello world");
    const textState = buildLunaDecisionState("notes.txt", "text/plain", text);
    expect(textState.image).toBeUndefined();
    expect(textState.excerpt).toContain("hello world");

    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    expect(buildLunaDecisionState("icon.svg", "image/svg+xml", svg).image).toBeUndefined();
    expect(
      buildLunaDecisionState("empty.png", "image/png", new Uint8Array()).image,
    ).toBeUndefined();

    const big = new Uint8Array(CLASSIFIER_MAX_IMAGE_BYTES + 1);
    const bigState = buildLunaDecisionState("huge.png", "image/png", big);
    expect(bigState.image).toBeUndefined();
    expect(bigState.note).toContain("image skipped");
  });
});

describe("buildLunaDecideRequest", () => {
  it("asks Luna the same closed enums", () => {
    const req = buildLunaDecideRequest(buildLunaDecisionState("a.png", "image/png", pngOf(32, 32)));
    expect(req.stage).toBe("decide");
    expect(req.model).toBe(CLASSIFIER_LUNA_MODEL);
    expect(Object.keys(req.questions)).toEqual(["kind", "surface", "screen"]);
    expect(req.state.image?.type).toBe("input_image");
  });
});

describe("openRouterLunaClassifierRun", () => {
  const req = buildLunaDecideRequest({
    filename: "a.png",
    content_type: "image/png",
    byte_size: 4,
    image: { type: "input_image", image_url: "data:image/png;base64,AAAA" },
  });

  it("posts decisions through the AI Gateway OpenRouter provider", async () => {
    const calls: Array<{
      id: string;
      data: {
        provider: string;
        endpoint: string;
        headers: Record<string, string>;
        query: { model: string; state: { image?: unknown }; questions: unknown };
      };
      options: { gateway?: { skipCache?: boolean } };
    }> = [];
    const run = openRouterLunaClassifierRun(
      env({
        OPENROUTER_API_KEY: "secret-key",
        AI: {
          gateway: (id: string) => ({
            run: async (data: unknown, options: unknown) => {
              calls.push({ id, data, options } as (typeof calls)[number]);
              return new Response(
                JSON.stringify({
                  answers: { kind: { type: "choice", choice: "photo", confidence: 0.9 } },
                }),
                { status: 200 },
              );
            },
          }),
        },
      }),
    );
    await expect(run(req)).resolves.toMatchObject({ answers: { kind: { choice: "photo" } } });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.id).toBe("uploads-classifier");
    expect(call.data.provider).toBe("openrouter");
    expect(call.data.endpoint).toBe(OPENROUTER_DECISIONS_ENDPOINT);
    expect(call.data.headers.Authorization).toBe("Bearer secret-key");
    expect(call.data.headers["Content-Type"]).toBe("application/json");
    expect(call.data.query.model).toBe(CLASSIFIER_LUNA_MODEL);
    expect(call.data.query.state.image).toEqual(req.state.image);
    expect(Object.keys(call.data.query.questions as object)).toEqual(["kind", "surface", "screen"]);
    expect(call.options.gateway?.skipCache).toBe(true);
  });

  it("does not run a describe stage", async () => {
    const run = openRouterLunaClassifierRun(env({ OPENROUTER_API_KEY: "k" }));
    await expect(run({ stage: "describe", model: "x", prompt: "p" })).rejects.toThrow(/describe/);
  });

  it("throws when the key is missing or the gateway is not ok", async () => {
    await expect(
      openRouterLunaClassifierRun(env({ OPENROUTER_API_KEY: "  " }))(req),
    ).rejects.toThrow(/OPENROUTER_API_KEY/);
    const run = openRouterLunaClassifierRun(
      env({
        OPENROUTER_API_KEY: "k",
        AI: {
          gateway: () => ({
            run: async () => new Response("nope", { status: 502 }),
          }),
        },
      }),
    );
    await expect(run(req)).rejects.toThrow(/502/);
  });
});

describe("buildDecideRequest", () => {
  it("asks Jev the three closed-enum questions", () => {
    const req = buildDecideRequest(buildClassifierState("a.png", "image/png", pngOf(390, 844)));
    expect(req.stage).toBe("decide");
    expect(req.model).toBe(CLASSIFIER_DECISION_MODEL);
    expect(Object.keys(req.questions)).toEqual(["kind", "surface", "screen"]);
    for (const question of Object.values(buildClassifierQuestions())) {
      expect(question.type).toBe("choice");
      expect(Object.keys(question.criteria).length).toBeGreaterThan(1);
    }
    expect(Object.keys(req.questions.surface.criteria)).toEqual([
      "mobile",
      "desktop",
      "tablet",
      "unknown",
    ]);
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

describe("parseDescribeOutput", () => {
  it("accepts a raw JSON object", () => {
    expect(
      parseDescribeOutput(
        '{"description":"A settings form.","tags":["ui","settings-page"],"summary":"A settings form"}',
      ),
    ).toEqual({
      description: "A settings form.",
      tags: ["ui", "settings-page"],
      summary: "A settings form",
    });
  });

  it("accepts a fenced JSON block and drops junk tags", () => {
    const raw = 'Sure.\n```json\n{"tags":["UI","!!!","ui","valid-tag"],"summary":"ok"}\n```\n';
    expect(parseDescribeOutput(raw)).toEqual({
      description: undefined,
      tags: ["ui", "valid-tag"],
      summary: "ok",
    });
  });

  it("keeps the first five valid tags", () => {
    expect(parseDescribeOutput('{"tags":["one","two","three","four","five","six"]}')?.tags).toEqual(
      ["one", "two", "three", "four", "five"],
    );
  });

  it("strips non-ASCII from the summary", () => {
    expect(parseDescribeOutput('{"summary":"Hello café"}')?.summary).toBe("Hello caf");
  });

  it("returns null when nothing usable remains", () => {
    expect(parseDescribeOutput("not json")).toBeNull();
    expect(parseDescribeOutput('{"tags":["!!!"]}')).toBeNull();
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

  it("unwraps a gateway-wrapped payload", () => {
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

describe("extractJsonObject / extractModelText", () => {
  it("reads common Workers AI shapes", () => {
    expect(extractModelText({ response: "hi" })).toBe("hi");
    expect(extractModelText({ description: "cap" })).toBe("cap");
    expect(extractModelText({ result: "out" })).toBe("out");
    expect(extractModelText("plain")).toBe("plain");
    expect(extractModelText(null)).toBe("");
  });

  it("stringifies an object-shaped response (AI Gateway / Workers AI)", () => {
    const payload = {
      response: {
        description: "A gradient background.",
        tags: ["gradient"],
        summary: "a gradient image",
      },
      tool_calls: [],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
    const text = extractModelText(payload);
    expect(text).toContain('"tags"');
    expect(parseDescribeOutput(text)).toEqual({
      description: "A gradient background.",
      tags: ["gradient"],
      summary: "a gradient image",
    });
  });

  it("reads OpenAI-ish choices[0].message.content", () => {
    expect(
      extractModelText({
        choices: [{ message: { content: '{"tags":["ui"],"summary":"ok"}' } }],
      }),
    ).toBe('{"tags":["ui"],"summary":"ok"}');
  });

  it("returns null for arrays and invalid JSON", () => {
    expect(extractJsonObject("[1]")).toBeNull();
    expect(extractJsonObject("{")).toBeNull();
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

  it("does not schedule when the workspace hard-off is set", () => {
    const waitUntil = vi.fn();
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
