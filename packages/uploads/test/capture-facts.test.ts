import { describe, expect, it } from "vitest";
import { captureFacts } from "../src/capture-facts.js";
import type { ScreenshotTarget } from "../src/screenshot.js";

const viewport = { width: 1280, height: 800, deviceScaleFactor: 2 };

function urlTarget(url: string, localOnly: boolean): ScreenshotTarget {
  return { kind: "url", url, localOnly };
}

describe("captureFacts", () => {
  it("derives url, path and viewport for a public URL", () => {
    const facts = captureFacts({
      target: urlTarget("https://app.example/settings?tab=billing#x", false),
      viewport,
    });
    expect(facts.url).toBe("https://app.example/settings?tab=billing#x");
    expect(facts.path).toBe("/settings");
    expect(facts.viewport).toBe("1280x800@2x");
  });

  it("omits env for a public host rather than guessing prod", () => {
    const facts = captureFacts({ target: urlTarget("https://app.example/a", false), viewport });
    expect(facts.env).toBeUndefined();
  });

  it("stamps env=local for a local target", () => {
    const facts = captureFacts({ target: urlTarget("http://localhost:4321/docs", true), viewport });
    expect(facts.env).toBe("local");
    expect(facts.path).toBe("/docs");
  });

  it("keeps the root path as /", () => {
    const facts = captureFacts({ target: urlTarget("https://app.example", false), viewport });
    expect(facts.path).toBe("/");
  });

  it("stamps theme only when a color scheme was forced", () => {
    const target = urlTarget("https://app.example/a", false);
    expect(captureFacts({ target, viewport }).theme).toBeUndefined();
    expect(captureFacts({ target, viewport, colorScheme: "dark" }).theme).toBe("dark");
    expect(captureFacts({ target, viewport, colorScheme: "light" }).theme).toBe("light");
  });

  it("emits only viewport for a local .html file target", () => {
    const facts = captureFacts({
      target: { kind: "html-file", path: "/tmp/card.html", html: "<p>x</p>" },
      viewport,
    });
    expect(facts).toEqual({ viewport: "1280x800@2x" });
  });

  it("drops an over-long url rather than failing the upload", () => {
    const long = `https://app.example/a?q=${"x".repeat(600)}`;
    const facts = captureFacts({ target: urlTarget(long, false), viewport });
    expect(facts.url).toBeUndefined();
    // The other facts survive the drop.
    expect(facts.path).toBe("/a");
    expect(facts.viewport).toBe("1280x800@2x");
  });

  it("never emits a value that breaks the metadata value rules", () => {
    const facts = captureFacts({ target: urlTarget("https://app.example/a", false), viewport });
    for (const value of Object.values(facts)) {
      expect(value.length).toBeGreaterThan(0);
      expect(value.length).toBeLessThanOrEqual(512);
      expect(/^[\x20-\x7E]+$/.test(value)).toBe(true);
    }
  });
});
