import { describe, expect, it } from "vitest";
import { decisionsUsage, writeClassifierCallPoint } from "./classifier-call-analytics";

describe("decisionsUsage", () => {
  it("reads camelCase and snake_case usage", () => {
    expect(decisionsUsage({ usage: { cost: 0.002, inputTokens: 10, outputTokens: 2 } })).toEqual({
      cost: 0.002,
      inputTokens: 10,
    });
    expect(decisionsUsage({ usage: { input_tokens: 7, output_tokens: 1 } })).toEqual({
      cost: -1,
      inputTokens: 7,
    });
  });

  it("marks a missing usage block as unpriced", () => {
    expect(decisionsUsage({ answers: {} })).toEqual({ cost: -1, inputTokens: 0 });
    expect(decisionsUsage(null)).toEqual({ cost: -1, inputTokens: 0 });
  });
});

describe("writeClassifierCallPoint", () => {
  it("is a no-op without the binding and never throws", () => {
    expect(() => writeClassifierCallPoint({} as Env, "m", {})).not.toThrow();
    const env = {
      CLASSIFIER_CALLS: {
        writeDataPoint: () => {
          throw new Error("ae down");
        },
      },
    } as unknown as Env;
    expect(() => writeClassifierCallPoint(env, "m", {})).not.toThrow();
  });
});
