import { describe, expect, it } from "vitest";
import {
  DOCS_HUB_URL,
  FALLBACK_DOCS_CATALOG,
  formatDocsHuman,
  parseDocsCatalog,
  rankDocsPages,
  resolveDocsPage,
  searchDocs,
} from "../src/docs.js";

describe("parseDocsCatalog", () => {
  it("reads pages, aliases, and the hub URL", () => {
    const doc = parseDocsCatalog({
      url: DOCS_HUB_URL,
      pages: [
        {
          page: "attach-pull-request-images",
          title: "Attach & share",
          url: "https://uploads.sh/docs/attach-pull-request-images",
          summary: "Stage then attach.",
          aliases: ["attach", "stage"],
        },
      ],
    });
    expect(doc.url).toBe(DOCS_HUB_URL);
    expect(doc.pages[0]?.aliases).toEqual(["attach", "stage"]);
  });

  it("rejects a payload with no usable pages", () => {
    expect(() => parseDocsCatalog({ url: DOCS_HUB_URL, pages: [{ title: "x" }] })).toThrow(
      /no usable pages/,
    );
  });
});

describe("resolveDocsPage", () => {
  const catalog = FALLBACK_DOCS_CATALOG;

  it("matches slug, alias, path, and URL", () => {
    expect(resolveDocsPage(catalog, "attach")?.page).toBe("attach-pull-request-images");
    expect(resolveDocsPage(catalog, "attach-pull-request-images")?.page).toBe(
      "attach-pull-request-images",
    );
    expect(resolveDocsPage(catalog, "/docs/agents")?.page).toBe("agents");
    expect(resolveDocsPage(catalog, "https://uploads.sh/docs/limits")?.page).toBe("limits");
  });

  it("returns undefined for an unknown slug", () => {
    expect(resolveDocsPage(catalog, "not-a-page")).toBeUndefined();
  });
});

describe("rankDocsPages", () => {
  it("ranks the attach page first for staging queries", () => {
    const ranked = rankDocsPages(FALLBACK_DOCS_CATALOG, "stage before a PR");
    expect(ranked[0]?.page).toBe("attach-pull-request-images");
  });

  it("ranks BYO bucket for an R2 query", () => {
    const ranked = rankDocsPages(FALLBACK_DOCS_CATALOG, "r2 bucket");
    expect(ranked[0]?.page).toBe("byo-bucket");
  });
});

describe("searchDocs", () => {
  it("lists the catalog when there is no query", async () => {
    const doc = await searchDocs({ catalog: FALLBACK_DOCS_CATALOG });
    expect(doc.url).toBe(DOCS_HUB_URL);
    expect(doc.results.length).toBe(FALLBACK_DOCS_CATALOG.pages.length);
    expect(doc.total).toBe(FALLBACK_DOCS_CATALOG.pages.length);
    expect(doc.results[0]?.body).toBeUndefined();
  });

  it("returns ranked snippets for a multi-word query", async () => {
    const doc = await searchDocs({
      catalog: FALLBACK_DOCS_CATALOG,
      query: "stage before a PR",
      limit: 3,
    });
    expect(doc.query).toBe("stage before a PR");
    expect(doc.results[0]?.page).toBe("attach-pull-request-images");
    expect(doc.results[0]?.url).toContain("/docs/attach-pull-request-images");
    expect(doc.results[0]?.body).toBeUndefined();
    expect(doc.results.length).toBeLessThanOrEqual(3);
  });

  it("fetches markdown for an exact slug", async () => {
    const markdown = "# Attach & share\n\nStage files with --branch.\n";
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      expect(url).toBe("https://uploads.sh/docs/attach-pull-request-images");
      return new Response(markdown, {
        status: 200,
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
    }) as typeof fetch;
    const doc = await searchDocs({
      catalog: FALLBACK_DOCS_CATALOG,
      query: "attach",
      fetchImpl,
    });
    expect(doc.results).toHaveLength(1);
    expect(doc.results[0]?.body).toBe(markdown);
    expect(doc.results[0]?.snippet).toContain("Stage files");
  });

  it("fetches markdown for --page even when the query would also match", async () => {
    const fetchImpl = (async () =>
      new Response("# Agents\n", {
        status: 200,
        headers: { "content-type": "text/markdown; charset=utf-8" },
      })) as typeof fetch;
    const doc = await searchDocs({
      catalog: FALLBACK_DOCS_CATALOG,
      page: "agents",
      fetchImpl,
    });
    expect(doc.results[0]?.page).toBe("agents");
    expect(doc.results[0]?.body).toBe("# Agents\n");
  });

  it("rejects an unknown page", async () => {
    await expect(
      searchDocs({ catalog: FALLBACK_DOCS_CATALOG, page: "not-a-page" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });
});

describe("formatDocsHuman", () => {
  it("prints titles, URLs, snippets, and a hub link", () => {
    const text = formatDocsHuman({
      url: DOCS_HUB_URL,
      results: [
        {
          title: "Attach & share",
          url: "https://uploads.sh/docs/attach-pull-request-images",
          page: "attach-pull-request-images",
          snippet: "Stage as you work.",
        },
      ],
      total: 1,
    });
    expect(text).toContain("Docs");
    expect(text).toContain("Attach & share");
    expect(text).toContain("https://uploads.sh/docs/attach-pull-request-images");
    expect(text).toContain("Stage as you work.");
    expect(text).toMatch(/See all docs: https:\/\/uploads\.sh\/docs\n$/);
  });

  it("prints the markdown body for a fetched page", () => {
    const text = formatDocsHuman({
      url: DOCS_HUB_URL,
      results: [
        {
          title: "Attach & share",
          url: "https://uploads.sh/docs/attach-pull-request-images",
          page: "attach-pull-request-images",
          snippet: "Stage files.",
          body: "# Attach & share\n\nStage files with --branch.\n",
        },
      ],
      total: 1,
    });
    expect(text).toContain("# Attach & share");
    expect(text).toContain("Stage files with --branch.");
    expect(text).not.toContain("See all docs:");
  });

  it("prints a zero-match line", () => {
    const text = formatDocsHuman({ url: DOCS_HUB_URL, results: [], total: 0 });
    expect(text).toContain("No matching docs.");
  });
});
