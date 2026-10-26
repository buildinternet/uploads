import { describe, expect, it } from "vitest";
import { mediaExtLabel, mediaTileView } from "./media-tile";

const url = "https://storage.uploads.sh/ws/shots/home.png";
const embedUrl = "https://embed.uploads.sh/ws/shots/home.png";
const available = { status: "available", url, embedUrl };

describe("mediaTileView", () => {
  it("shows an image from the stable url with the leaf name as alt", () => {
    expect(
      mediaTileView({ ...available, key: "shots/home.png", contentType: "image/png" }),
    ).toEqual({ mode: "image", src: url, alt: "home.png" });
  });

  it("falls back to embedUrl when url is null", () => {
    expect(
      mediaTileView({
        key: "a.png",
        status: "available",
        url: null,
        embedUrl,
        contentType: "image/png",
      }),
    ).toEqual({ mode: "image", src: embedUrl, alt: "a.png" });
  });

  it("classifies by key extension when contentType is absent (ThumbItem rows)", () => {
    expect(mediaTileView({ ...available, key: "shots/Home.PNG" })).toMatchObject({ mode: "image" });
    expect(mediaTileView({ ...available, key: "clip.mov", contentType: null })).toEqual({
      mode: "video",
      src: url,
      poster: null,
    });
  });

  it("keeps a video's poster", () => {
    const poster = "https://storage.uploads.sh/ws/clip.poster.webp";
    expect(
      mediaTileView({ ...available, key: "clip.mp4", contentType: "video/mp4", posterUrl: poster }),
    ).toEqual({ mode: "video", src: url, poster });
  });

  it("plays a video without a poster from its source", () => {
    expect(mediaTileView({ ...available, key: "clip.webm", contentType: "video/webm" })).toEqual({
      mode: "video",
      src: url,
      poster: null,
    });
  });

  it("shows a PDF's derived poster", () => {
    const poster = "https://storage.uploads.sh/ws/spec.pdf.poster.webp";
    expect(
      mediaTileView({
        ...available,
        key: "spec.pdf",
        contentType: "application/pdf",
        posterUrl: poster,
      }),
    ).toEqual({ mode: "poster", src: poster });
  });

  it("locks withheld items", () => {
    expect(
      mediaTileView({
        key: "a.png",
        status: "withheld",
        url: null,
        embedUrl: null,
        contentType: null,
      }),
    ).toEqual({ mode: "locked" });
  });

  it("locks an available image with no URL (no public base configured)", () => {
    expect(mediaTileView({ key: "a.png", status: "available", url: null, embedUrl: null })).toEqual(
      {
        mode: "locked",
      },
    );
  });

  it("marks missing items", () => {
    expect(
      mediaTileView({
        key: "a.png",
        status: "missing",
        url: null,
        embedUrl: null,
        contentType: null,
      }),
    ).toEqual({ mode: "missing" });
  });

  it("falls back to an extension tile for unknown types", () => {
    expect(mediaTileView({ ...available, key: "notes.txt", contentType: "text/plain" })).toEqual({
      mode: "ext",
      label: "txt",
    });
    expect(mediaTileView({ ...available, key: "README" })).toEqual({ mode: "ext", label: "file" });
  });

  it("treats an empty contentType as a plain file, as /c/ does today", () => {
    expect(mediaTileView({ ...available, key: "home.png", contentType: "" })).toEqual({
      mode: "ext",
      label: "png",
    });
  });
});

describe("mediaExtLabel", () => {
  it("lowercases a short extension and falls back to 'file'", () => {
    expect(mediaExtLabel("a/b/Report.PDF")).toBe("pdf");
    expect(mediaExtLabel("archive.tar.gz")).toBe("gz");
    expect(mediaExtLabel("Makefile")).toBe("file");
    expect(mediaExtLabel("x.waytoolongext")).toBe("file");
  });
});
