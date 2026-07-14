import { describe, expect, it } from "vitest";
import { buildEmbedFormats } from "./embed-formats";

const base = {
  canonical: "https://uploads.sh/f/acme/screenshots/shot.png",
  url: "https://storage.uploads.sh/acme/screenshots/shot.png",
  embedUrl: "https://embed.uploads.sh/acme/screenshots/shot.png" as string | null,
  filename: "shot.png",
};

describe("buildEmbedFormats", () => {
  it("returns all five formats, in order, for an image", () => {
    const formats = buildEmbedFormats({ ...base, kind: "image" });
    expect(formats.map((f) => f.id)).toEqual([
      "page",
      "url",
      "markdown-image",
      "markdown-link",
      "html-img",
    ]);
    expect(formats).toEqual([
      { id: "page", label: "Page link", value: base.canonical },
      { id: "url", label: "Direct file URL", value: base.url },
      { id: "markdown-image", label: "Markdown image", value: `![](${base.embedUrl})` },
      { id: "markdown-link", label: "Markdown link", value: `[shot.png](${base.canonical})` },
      {
        id: "html-img",
        label: "HTML <img>",
        value: `<img src="${base.embedUrl}" alt="shot.png">`,
      },
    ]);
  });

  it("drops the markdown-image and html-img formats for video/file/unsupported kinds", () => {
    for (const kind of ["video", "file", "unsupported"] as const) {
      const formats = buildEmbedFormats({ ...base, kind });
      expect(formats.map((f) => f.id)).toEqual(["page", "url", "markdown-link"]);
    }
  });

  it("embed snippet formats prefer embedUrl over url; Direct file URL always uses the stable url", () => {
    const formats = buildEmbedFormats({ ...base, kind: "image" });
    const direct = formats.find((f) => f.id === "url")!;
    const mdImage = formats.find((f) => f.id === "markdown-image")!;
    const html = formats.find((f) => f.id === "html-img")!;
    expect(direct.value).toBe(base.url);
    expect(mdImage.value).toContain(base.embedUrl);
    expect(html.value).toContain(base.embedUrl);
  });

  it("falls back to url for embed snippets when embedUrl is null", () => {
    const formats = buildEmbedFormats({ ...base, embedUrl: null, kind: "image" });
    expect(formats.find((f) => f.id === "markdown-image")!.value).toBe(`![](${base.url})`);
    expect(formats.find((f) => f.id === "html-img")!.value).toBe(
      `<img src="${base.url}" alt="shot.png">`,
    );
  });

  it("HTML-escapes the filename in the html-img alt attribute", () => {
    const formats = buildEmbedFormats({
      ...base,
      filename: 'a"><b.png',
      kind: "image",
    });
    const html = formats.find((f) => f.id === "html-img")!;
    expect(html.value).toBe(`<img src="${base.embedUrl}" alt="a&quot;&gt;&lt;b.png">`);
    const altStart = html.value.indexOf('alt="') + 'alt="'.length;
    const alt = html.value.slice(altStart, html.value.length - '">'.length);
    expect(alt).toBe("a&quot;&gt;&lt;b.png");
    expect(alt).not.toContain('"');
    expect(alt).not.toContain("<");
  });
});
