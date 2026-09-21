import { describe, expect, it, vi } from "vitest";
import {
  CLASSIFIER_DECISION_MODEL,
  CLASSIFIER_FLAG,
  CLASSIFIER_MAX_IMAGE_BYTES,
  CLASSIFIER_VISION_MODEL,
  buildClassifierQuestions,
  buildClassifierState,
  buildDecideRequest,
  buildDescribeRequest,
  classificationAllowed,
  classifierEvaluationContext,
  classifierGatewayId,
  extractJsonObject,
  extractModelText,
  parseDescribeOutput,
  parseJevAnswers,
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
