import { describe, expect, it } from "vitest";
import { buildMarkdown } from "../src/embed.js";

describe("buildMarkdown", () => {
  it("emits image markdown without width", () => {
    expect(buildMarkdown("https://x.test/a.png", { alt: "shot" })).toBe(
      "![shot](https://x.test/a.png)",
    );
  });

  it("emits an img tag with width", () => {
    expect(buildMarkdown("https://x.test/a.png", { alt: "shot", width: 700 })).toBe(
      '<img width="700" alt="shot" src="https://x.test/a.png">',
    );
  });
});
