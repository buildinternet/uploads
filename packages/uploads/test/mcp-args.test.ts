import { describe, expect, it } from "vitest";
import { UsageError } from "../src/cli-args.js";
import { optStringRecord } from "../src/mcp/args.js";
import { validateMetaMap } from "../src/metadata.js";

describe("optStringRecord", () => {
  it("parses a plain string-value object", () => {
    expect(optStringRecord({ metadata: { app: "myapp", page: "settings" } }, "metadata")).toEqual({
      app: "myapp",
      page: "settings",
    });
  });

  it("returns undefined when the arg is absent", () => {
    expect(optStringRecord({}, "metadata")).toBeUndefined();
  });

  it("does not silently drop a __proto__ key (prototype-pollution guard)", () => {
    // Use JSON.parse, not an object literal: `{ __proto__: "x" }` in source
    // is special-cased by the language to set the prototype rather than
    // create an own property, which would falsely pass this test. Real MCP
    // input arrives JSON-parsed (JSON.parse creates a genuine own property
    // named "__proto__" via CreateDataProperty), which is the case that
    // actually reaches optStringRecord.
    const args = JSON.parse('{"metadata":{"__proto__":"x"}}') as { metadata: unknown };
    const result = optStringRecord(args, "metadata");
    // A plain `{}` accumulator would have result["__proto__"] = v hit the
    // inherited setter and vanish, leaving `{}` — which downstream code
    // treats as "clear all metadata" instead of an invalid key. With a
    // null-prototype accumulator, __proto__ becomes a real own key that
    // reaches (and is rejected by) metadata key validation.
    expect(result).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(true);
    expect(Object.keys(result!)).toContain("__proto__");
    expect(() => validateMetaMap(result!)).toThrow(UsageError);
  });
});
