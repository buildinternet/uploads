import { describe, expect, it } from "vitest";
import { HOME_FAQ, homeFaqJsonLd } from "./home-seo";

function visibleAnswer(html: string): string {
  return html
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll(/\s+/g, " ")
    .trim();
}

describe("homepage FAQ JSON-LD", () => {
  it("matches the rendered FAQ items and contains no HTML", () => {
    const ld = JSON.parse(homeFaqJsonLd()) as {
      "@type": string;
      mainEntity: { name: string; acceptedAnswer: { text: string } }[];
    };

    expect(ld["@type"]).toBe("FAQPage");
    expect(ld.mainEntity.map((item) => item.name)).toEqual(HOME_FAQ.map((item) => item.q));
    for (const [index, item] of HOME_FAQ.entries()) {
      const text = ld.mainEntity[index]?.acceptedAnswer.text;
      expect(text).toBe(visibleAnswer(item.a));
      expect(text).not.toMatch(/<[^>]+>/);
    }
  });
});
