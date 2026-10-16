import { describe, expect, it } from "vitest";
import { PLAN_FACTS } from "./plan-facts";
import {
  HOME_BEST_FOR,
  HOME_DESCRIPTION,
  HOME_FAQ,
  homeFaqJsonLd,
  homeFaqPlainText,
} from "./home-seo";

describe("homepage SEO copy", () => {
  it("keeps the meta description near 150 characters and leads with the claim", () => {
    expect(HOME_DESCRIPTION.length).toBeGreaterThanOrEqual(140);
    expect(HOME_DESCRIPTION.length).toBeLessThanOrEqual(160);
    expect(HOME_DESCRIPTION.startsWith("Attach screenshots")).toBe(true);
    expect(HOME_DESCRIPTION).toContain("one auto-updating PR comment");
  });

  it("names the runtimes the hero line is for", () => {
    expect(HOME_BEST_FOR).toContain("GitHub App tokens");
    expect(HOME_BEST_FOR).toContain("Claude Code cloud sessions");
    expect(HOME_BEST_FOR).toContain("Free to start");
  });

  it("publishes five to seven FAQ answers that match the JSON-LD", () => {
    expect(HOME_FAQ.length).toBeGreaterThanOrEqual(5);
    expect(HOME_FAQ.length).toBeLessThanOrEqual(7);

    const ld = JSON.parse(homeFaqJsonLd()) as {
      "@type": string;
      mainEntity: { name: string; acceptedAnswer: { text: string } }[];
    };
    expect(ld["@type"]).toBe("FAQPage");
    expect(ld.mainEntity.map((item) => item.name)).toEqual(HOME_FAQ.map((item) => item.q));
    for (const [index, item] of HOME_FAQ.entries()) {
      expect(item.q.length).toBeGreaterThan(10);
      const plain = homeFaqPlainText(item);
      expect(plain.length).toBeGreaterThan(40);
      expect(plain).not.toMatch(/<[^>]+>/);
      expect(ld.mainEntity[index]?.acceptedAnswer.text).toBe(plain);
    }
  });

  it("uses the phrases people search for", () => {
    const corpus = [
      HOME_DESCRIPTION,
      HOME_BEST_FOR,
      ...HOME_FAQ.map((item) => `${item.q} ${homeFaqPlainText(item)}`),
    ].join("\n");
    expect(corpus).toContain("attach a screenshot to a GitHub PR");
    expect(corpus).toContain("gh has no attachment upload");
    expect(corpus).toContain("GitHub App token");
    expect(corpus).toContain("Claude Code cloud");
  });

  it("states plan numbers from the catalog and does not invent a rate quota", () => {
    const pay = homeFaqPlainText(HOME_FAQ[3]!);
    expect(pay).toContain(PLAN_FACTS.freeStorage);
    expect(pay).toContain(PLAN_FACTS.freeMaxUpload);
    expect(pay).toContain(PLAN_FACTS.proStorage);
    expect(pay).toContain(PLAN_FACTS.proMaxUpload);
    expect(pay).toContain("Cloudflare R2");
    expect(pay).toContain("Amazon S3");
    expect(pay).toContain("unmetered");
    expect(pay).toContain("fair-use API limits");
    expect(pay).toContain("hundreds of screenshots");
    expect(pay).not.toContain("thousands of screenshots");
    expect(pay).not.toMatch(/\b(60|3000|100000)\b/);
  });

  it("keeps the gh attachment answer to the token gap", () => {
    const gh = homeFaqPlainText(HOME_FAQ[1]!);
    expect(gh).toContain("no public API for attachments");
    expect(gh).toContain("installation token");
    expect(gh).toContain("Claude Code cloud session");
    expect(gh).toContain("posts one comment on the pull request");
    expect(gh).not.toMatch(/2\.99|September 2026/);
  });

  it("links self-hosting and describes private-repo URLs", () => {
    const source = homeFaqPlainText(HOME_FAQ[4]!);
    expect(source).toContain("Apache 2.0");
    const selfHost = HOME_FAQ[4]!.paragraphs
      .flat()
      .find((span) => span.href?.includes("docs/ops.md"));
    expect(selfHost?.href).toContain("minimal-binding-profile");
    expect(
      HOME_FAQ[4]!.paragraphs
        .flat()
        .some((span) => span.href === "https://github.com/buildinternet/uploads"),
    ).toBe(true);

    const priv = homeFaqPlainText(HOME_FAQ[5]!);
    expect(priv).toContain("private");
    expect(priv).toContain("unguessable prefix");
    expect(priv).toContain("Anyone with the file URL");
  });
});
