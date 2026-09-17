import { describe, expect, it, vi } from "vitest";
import {
  CLASSIFIER_FLAG,
  CLASSIFIER_MAX_IMAGE_BYTES,
  CLASSIFIER_TEXT_MODEL,
  CLASSIFIER_VERSION,
  CLASSIFIER_VISION_MODEL,
  buildClassifierRequest,
  classificationAllowed,
  classifierGatewayId,
  extractJsonObject,
  extractModelText,
  parseClassifierOutput,
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

describe("classificationAllowed", () => {
  it("allows only when AI, Flagship, and workspace opt-in are all open", async () => {
    expect(await classificationAllowed(env(), { llmClassifierEnabled: true })).toBe(true);
  });

  it("denies when the workspace has not opted in (default)", async () => {
    expect(await classificationAllowed(env(), {})).toBe(false);
    expect(await classificationAllowed(env(), { llmClassifierEnabled: false })).toBe(false);
  });

  it("denies when the AI binding is absent", async () => {
    expect(
      await classificationAllowed(env({ AI: undefined }), { llmClassifierEnabled: true }),
    ).toBe(false);
  });

  it("fails closed when Flagship is missing, off, or throws", async () => {
    expect(
      await classificationAllowed(env({ FLAGS: undefined }), { llmClassifierEnabled: true }),
    ).toBe(false);
    expect(
      await classificationAllowed(env({ FLAGS: flagsOff }), { llmClassifierEnabled: true }),
    ).toBe(false);
    const flagsThrows = {
      getBooleanValue: async () => {
        throw new Error("flagship unreachable");
      },
    };
    expect(
      await classificationAllowed(env({ FLAGS: flagsThrows }), { llmClassifierEnabled: true }),
    ).toBe(false);
  });

  it("asks Flagship for the classifier flag with a closed default", async () => {
    let seen: { name?: string; def?: boolean } = {};
    const flags = {
      getBooleanValue: async (name: string, def: boolean) => {
        seen = { name, def };
        return true;
      },
    };
    await classificationAllowed(env({ FLAGS: flags }), { llmClassifierEnabled: true });
    expect(seen).toEqual({ name: CLASSIFIER_FLAG, def: false });
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

describe("buildClassifierRequest", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("sends raster images under the cap to the vision model", () => {
    const req = buildClassifierRequest("screenshots/settings.png", "image/png", png);
    expect(req.model).toBe(CLASSIFIER_VISION_MODEL);
    expect(req.image).toBe(png);
    expect(req.prompt).toContain("filename: settings.png");
    expect(req.prompt).toContain("content-type: image/png");
  });

  it("does not attach bytes for oversized images", () => {
    const big = new Uint8Array(CLASSIFIER_MAX_IMAGE_BYTES + 1);
    const req = buildClassifierRequest("huge.png", "image/png", big);
    expect(req.model).toBe(CLASSIFIER_TEXT_MODEL);
    expect(req.image).toBeUndefined();
    expect(req.prompt).toContain("image skipped");
  });

  it("does not attach SVG bytes", () => {
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    const req = buildClassifierRequest("icon.svg", "image/svg+xml", svg);
    expect(req.image).toBeUndefined();
    expect(req.model).toBe(CLASSIFIER_TEXT_MODEL);
  });

  it("includes a short text excerpt for text/plain", () => {
    const bytes = new TextEncoder().encode("export function hello() { return 1; }\n");
    const req = buildClassifierRequest("src/hello.ts", "text/plain", bytes);
    expect(req.model).toBe(CLASSIFIER_TEXT_MODEL);
    expect(req.image).toBeUndefined();
    expect(req.prompt).toContain("excerpt:");
    expect(req.prompt).toContain("export function hello");
  });

  it("classifies zip/pdf from filename and type only", () => {
    const req = buildClassifierRequest("notes.pdf", "application/pdf", new Uint8Array([1, 2, 3]));
    expect(req.image).toBeUndefined();
    expect(req.prompt).not.toContain("excerpt:");
    expect(req.prompt).toContain("filename: notes.pdf");
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

describe("parseClassifierOutput", () => {
  it("accepts a raw JSON object", () => {
    expect(
      parseClassifierOutput(
        '{"tags":["ui","settings-page"],"summary":"A settings form","kind":"screenshot"}',
      ),
    ).toEqual({
      "ai.classifier": CLASSIFIER_VERSION,
      "ai.tags": "ui,settings-page",
      "ai.summary": "A settings form",
      "ai.kind": "screenshot",
    });
  });

  it("accepts a fenced JSON block and drops junk tags", () => {
    const raw = 'Sure.\n```json\n{"tags":["UI","!!!","ui","valid-tag"],"kind":"other"}\n```\n';
    expect(parseClassifierOutput(raw)).toEqual({
      "ai.classifier": CLASSIFIER_VERSION,
      "ai.tags": "ui,valid-tag",
      "ai.kind": "other",
    });
  });

  it("returns null when nothing usable remains", () => {
    expect(parseClassifierOutput("not json")).toBeNull();
    expect(parseClassifierOutput('{"tags":["!!!"],"kind":"nope"}')).toBeNull();
  });

  it("strips non-ASCII from the summary", () => {
    const meta = parseClassifierOutput('{"summary":"Hello café","kind":"other"}');
    expect(meta?.["ai.summary"]).toBe("Hello caf");
  });
});

describe("extractJsonObject / extractModelText", () => {
  it("reads common Workers AI shapes", () => {
    expect(extractModelText({ response: "hi" })).toBe("hi");
    expect(extractModelText({ description: "cap" })).toBe("cap");
    expect(extractModelText("plain")).toBe("plain");
    expect(extractModelText(null)).toBe("");
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
      { provider: "r2", bucket: "b", llmClassifierEnabled: true },
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
        { provider: "r2", bucket: "b", llmClassifierEnabled: true },
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
});
