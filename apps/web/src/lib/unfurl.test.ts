import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OG_DEFAULT_IMAGE } from "./og";
import {
  collectionPreview,
  isPublicMediaUrl,
  playerPageUrl,
  renderPlayerDocument,
  renderPlayerIframe,
  renderUnfurlMeta,
  videoFrame,
} from "./unfurl";

const SITE = "https://uploads.sh";
const PAGE = "https://uploads.sh/c/feed_abcdefghijklmnopqrstuv/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MP4 = "https://storage.uploads.sh/acme/clips/demo.mp4";
const POSTER = "https://storage.uploads.sh/acme/_internal/posters/clips/demo.mp4.jpg";
const PNG = "https://storage.uploads.sh/acme/screenshots/shot.png";

function content(html: string, attr: "property" | "name", name: string): string | undefined {
  const match = new RegExp(`<meta ${attr}="${name}" content="([^"]*)" />`).exec(html);
  return match?.[1];
}

describe("videoFrame / isPublicMediaUrl", () => {
  it("uses stored dimensions and falls back when they are missing or unsafe", () => {
    expect(videoFrame(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(videoFrame(null, null)).toEqual({ width: 1280, height: 720 });
    expect(videoFrame(1920, undefined)).toEqual({ width: 1280, height: 720 });
    expect(videoFrame(0, 1080)).toEqual({ width: 1280, height: 720 });
    expect(videoFrame(9000, 4000)).toEqual({ width: 1280, height: 720 });
  });

  it("accepts only credential-free https URLs within Discord's URL cap", () => {
    expect(isPublicMediaUrl(MP4)).toBe(true);
    expect(isPublicMediaUrl("http://storage.uploads.sh/acme/clips/demo.mp4")).toBe(false);
    expect(isPublicMediaUrl("https://user:pass@storage.uploads.sh/a.mp4")).toBe(false);
    expect(isPublicMediaUrl("javascript:alert(1)")).toBe(false);
    expect(isPublicMediaUrl(`https://storage.uploads.sh/${"a".repeat(2100)}.mp4`)).toBe(false);
  });
});

describe("renderUnfurlMeta", () => {
  it("emits a playable video card and keeps the poster as og:image", () => {
    const html = renderUnfurlMeta({
      pageUrl: PAGE,
      siteOrigin: SITE,
      title: 'clip "demo".mp4',
      description: "clip in the live link.",
      kind: "video",
      mediaUrl: MP4,
      contentType: "video/mp4",
      posterUrl: POSTER,
      width: 1920,
      height: 1080,
    });

    expect(content(html, "property", "og:type")).toBe("video.other");
    expect(content(html, "property", "og:video")).toBe(MP4);
    expect(content(html, "property", "og:video:secure_url")).toBe(MP4);
    expect(content(html, "property", "og:video:type")).toBe("video/mp4");
    expect(content(html, "property", "og:video:width")).toBe("1920");
    expect(content(html, "property", "og:video:height")).toBe("1080");
    expect(content(html, "property", "og:image")).toBe(POSTER);
    expect(content(html, "name", "twitter:card")).toBe("player");
    expect(content(html, "name", "twitter:player")).toBe(playerPageUrl(SITE, PAGE));
    expect(content(html, "name", "twitter:player:width")).toBe("1920");
    expect(content(html, "name", "twitter:player:height")).toBe("1080");
    expect(content(html, "name", "twitter:player:stream")).toBe(MP4);
    expect(content(html, "name", "twitter:player:stream:content_type")).toBe("video/mp4");
    expect(html).toContain('content="clip &quot;demo&quot;.mp4"');
    expect(html).not.toContain("http://");
  });

  it("falls back to 1280×720 and the brand card when a video has no metadata", () => {
    const html = renderUnfurlMeta({
      pageUrl: PAGE,
      siteOrigin: SITE,
      title: "demo.webm",
      description: "A public video.",
      kind: "video",
      mediaUrl: "https://storage.uploads.sh/acme/clips/demo.webm",
      contentType: "video/webm; codecs=vp9",
    });
    expect(content(html, "property", "og:video:type")).toBe("video/webm");
    expect(content(html, "property", "og:video:width")).toBe("1280");
    expect(content(html, "property", "og:video:height")).toBe("720");
    expect(content(html, "property", "og:image")).toBe(OG_DEFAULT_IMAGE);
    expect(content(html, "name", "twitter:player:stream:content_type")).toBe("video/webm");
  });

  it("does not emit a video URL for a private, non-video, or non-https file", () => {
    const privateHtml = renderUnfurlMeta({
      pageUrl: PAGE,
      siteOrigin: SITE,
      title: "Media unavailable",
      description: "A public live link hosted by uploads.sh.",
      kind: "other",
      mediaUrl: null,
    });
    expect(privateHtml).not.toContain("og:video");
    expect(privateHtml).not.toContain(MP4);
    expect(content(privateHtml, "property", "og:type")).toBe("website");
    expect(content(privateHtml, "name", "twitter:card")).toBe("summary_large_image");

    const httpHtml = renderUnfurlMeta({
      pageUrl: PAGE,
      siteOrigin: SITE,
      title: "demo.mp4",
      description: "nope",
      kind: "video",
      mediaUrl: "http://storage.uploads.sh/secret.mp4",
      contentType: "video/mp4",
      posterUrl: "http://storage.uploads.sh/secret.jpg",
    });
    expect(httpHtml).not.toContain("og:video");
    expect(httpHtml).not.toContain("secret");
    expect(content(httpHtml, "property", "og:image")).toBe(OG_DEFAULT_IMAGE);

    const textHtml = renderUnfurlMeta({
      pageUrl: PAGE,
      siteOrigin: SITE,
      title: "notes.txt",
      description: "A public file.",
      kind: "video",
      mediaUrl: "https://storage.uploads.sh/acme/notes.txt",
      contentType: "text/plain",
    });
    expect(textHtml).not.toContain("og:video");
  });

  it("uses summary_large_image and twitter:image for a public image", () => {
    const html = renderUnfurlMeta({
      pageUrl: "https://uploads.sh/f/acme/screenshots/shot.png",
      siteOrigin: SITE,
      title: "shot.png",
      description: "Public file hosted by uploads.sh.",
      kind: "image",
      mediaUrl: PNG,
      contentType: "image/png",
    });
    expect(content(html, "property", "og:type")).toBe("website");
    expect(content(html, "property", "og:image")).toBe(PNG);
    expect(content(html, "name", "twitter:card")).toBe("summary_large_image");
    expect(content(html, "name", "twitter:image")).toBe(PNG);
    expect(html).not.toContain("og:video");
    expect(html).not.toContain("twitter:player");
  });

  it("keeps a PDF poster as a large image and does not treat the PDF as video", () => {
    const pdf = "https://storage.uploads.sh/acme/report.pdf";
    const poster = "https://storage.uploads.sh/acme/_internal/posters/report.pdf.jpg";
    const html = renderUnfurlMeta({
      pageUrl: "https://uploads.sh/f/acme/report.pdf",
      siteOrigin: SITE,
      title: "report.pdf",
      description: "Public file hosted by uploads.sh.",
      kind: "other",
      mediaUrl: pdf,
      contentType: "application/pdf",
      posterUrl: poster,
    });
    expect(content(html, "property", "og:image")).toBe(poster);
    expect(content(html, "name", "twitter:image")).toBe(poster);
    expect(html).not.toContain(pdf);
    expect(html).not.toContain("og:video");
  });
});

describe("player document", () => {
  it("renders one video element and refuses anything that is not a public video", () => {
    const html = renderPlayerDocument({
      title: 'clip "1"',
      videoUrl: MP4,
      contentType: "video/quicktime",
      posterUrl: POSTER,
    });
    expect(html).toContain(`<video src="${MP4}" poster="${POSTER}" controls playsinline`);
    expect(html).toContain("<title>clip &quot;1&quot;</title>");
    expect(html).not.toContain("<script");

    expect(
      renderPlayerDocument({
        title: "nope",
        videoUrl: "http://storage.uploads.sh/secret.mp4",
        contentType: "video/mp4",
      }),
    ).toBeNull();
    expect(
      renderPlayerDocument({
        title: "nope",
        videoUrl: PNG,
        contentType: "image/png",
      }),
    ).toBeNull();
  });

  it("builds an iframe that points at /player and not at the media bytes", () => {
    const html = renderPlayerIframe({
      siteOrigin: SITE,
      pageUrl: PAGE,
      width: 1920,
      height: 1080,
      title: "demo.mp4",
    });
    expect(html).toContain(`src="${playerPageUrl(SITE, PAGE)}"`);
    expect(html).not.toContain(MP4);
    expect(
      renderPlayerIframe({
        siteOrigin: SITE,
        pageUrl: "https://evil.example/c/feed_abcdefghijklmnopqrstuv/x",
        width: 100,
        height: 100,
        title: "x",
      }),
    ).toBeNull();
  });
});

describe("collectionPreview", () => {
  it("prefers the cover image, then any image, then a poster", () => {
    const items = [
      {
        id: "video",
        kind: "video",
        url: MP4,
        posterUrl: POSTER,
      },
      { id: "shot", kind: "image", url: PNG, posterUrl: null },
    ];
    expect(collectionPreview(items, "shot")).toEqual({ url: PNG, source: "image" });
    expect(collectionPreview(items, "missing")).toEqual({ url: PNG, source: "image" });
    expect(
      collectionPreview([{ id: "video", kind: "video", url: MP4, posterUrl: POSTER }]),
    ).toEqual({ url: POSTER, source: "poster" });
    expect(
      collectionPreview([
        { kind: "missing", url: null, posterUrl: null },
        { kind: "image", url: "http://insecure.example/a.png" },
      ]),
    ).toBeNull();
  });
});

describe("share pages render unfurl tags through UnfurlMeta", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const pages = [
    "pages/f/[workspace]/[...key].astro",
    "pages/g/[id].astro",
    "pages/g/[id]/[item].astro",
    "pages/c/[id].astro",
    "pages/c/[id]/[item].astro",
  ];

  it.each(pages)("%s has no hand-written og:type", (page) => {
    const src = readFileSync(join(root, page), "utf8");
    expect(src).toContain("<UnfurlMeta");
    expect(src).not.toContain('property="og:type"');
    expect(src).not.toContain('property="og:image"');
  });
});
