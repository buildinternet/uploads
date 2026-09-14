import { describe, expect, it } from "vitest";
import { aliasesFor, renderDocsCatalog } from "./docs-catalog";

describe("renderDocsCatalog", () => {
  it("points at the public docs hub and expands paths to URLs", () => {
    const json = renderDocsCatalog([
      {
        page: "attach-pull-request-images",
        path: "/docs/attach-pull-request-images",
        title: "Attach & share",
        summary: "Stage then attach.",
        aliases: ["attach", "stage"],
      },
    ]);
    expect(json.url).toBe("https://uploads.sh/docs");
    expect(json.pages[0]).toEqual({
      page: "attach-pull-request-images",
      title: "Attach & share",
      url: "https://uploads.sh/docs/attach-pull-request-images",
      summary: "Stage then attach.",
      aliases: ["attach", "stage"],
    });
  });

  it("throws on an empty page list rather than publishing an empty catalog", () => {
    expect(() => renderDocsCatalog([])).toThrow(/empty/i);
  });
});

describe("aliasesFor", () => {
  it("includes nav slugs and skips the page id itself", () => {
    const aliases = aliasesFor("attach-pull-request-images", ["attach"]);
    expect(aliases).toContain("attach");
    expect(aliases).toContain("stage");
    expect(aliases).not.toContain("attach-pull-request-images");
  });
});
