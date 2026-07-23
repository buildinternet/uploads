import { describe, expect, it, vi } from "vitest";
import {
  applyPublicFileHeaders,
  authRequiredFileCsp,
  fetchPublicFile,
  fileDownloadUrl,
  fileKind,
  filePath,
  formatBytes,
  formatFileDate,
  isPublicFile,
  isSafeKey,
  PUBLIC_FILE_CSP,
  publicFileCsp,
  sameUtcDay,
  shouldShowModified,
} from "./public-file";

const file = {
  workspace: "acme",
  key: "screenshots/shot.png",
  url: "https://storage.uploads.sh/acme/screenshots/shot.png",
  embedUrl: "https://embed.uploads.sh/acme/screenshots/shot.png" as string | null,
  size: 20480,
  contentType: "image/png",
  uploaded: "2026-07-13T12:00:00.000Z",
} as const;

describe("public file headers", () => {
  it("locks down like the public gallery: no-store, noindex, strict CSP", () => {
    expect(PUBLIC_FILE_CSP).toContain("default-src 'none'");
    expect(PUBLIC_FILE_CSP).toContain("frame-ancestors 'none'");
    expect(PUBLIC_FILE_CSP).toContain("style-src 'self' 'unsafe-inline'");
    // Default CSP (prod API origin) allows Report-a-problem + RUM.
    expect(PUBLIC_FILE_CSP).toContain("connect-src https://api.uploads.sh");
    const headers = new Headers();
    applyPublicFileHeaders(headers);
    expect(headers.get("Content-Security-Policy")).toBe(PUBLIC_FILE_CSP);
    expect(headers.get("Cache-Control")).toBe("no-store");
    expect(headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
  });

  it("publicFileCsp / authRequiredFileCsp share API connect-src for report + session probe", () => {
    const publicCsp = publicFileCsp("https://api.example.test");
    const authCsp = authRequiredFileCsp("https://api.example.test");
    expect(publicCsp).toBe(authCsp);
    expect(publicCsp).toContain("default-src 'none'");
    expect(publicCsp).toContain("script-src 'self' 'unsafe-inline'");
    expect(publicCsp).toContain("connect-src https://api.example.test");
    expect(publicCsp).toContain("https://cloudflareinsights.com");
    expect(publicCsp).toContain("frame-ancestors 'none'");

    const headers = new Headers();
    applyPublicFileHeaders(headers, { csp: publicCsp });
    expect(headers.get("Content-Security-Policy")).toBe(publicCsp);
    expect(headers.get("Cache-Control")).toBe("no-store");
  });

  it("widens script-src on the ok branch for copy + report controls", () => {
    expect(PUBLIC_FILE_CSP).toContain(
      "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
    );
  });
});

describe("isPublicFile", () => {
  it("accepts the bounded DTO and tolerates a missing/null uploaded", () => {
    expect(isPublicFile(file)).toBe(true);
    expect(isPublicFile({ ...file, uploaded: null })).toBe(true);
    const { uploaded: _omit, ...noUploaded } = file;
    expect(isPublicFile(noUploaded)).toBe(true);
  });

  it("accepts a null embedUrl but rejects a non-https one", () => {
    expect(isPublicFile({ ...file, embedUrl: null })).toBe(true);
    expect(isPublicFile({ ...file, embedUrl: "http://embed.uploads.sh/x" })).toBe(false);
    const { embedUrl: _omit, ...noEmbedUrl } = file;
    expect(isPublicFile(noEmbedUrl)).toBe(false);
  });

  it("rejects non-https URLs, bad sizes, and over-long content types", () => {
    expect(isPublicFile({ ...file, url: "http://storage.uploads.sh/x" })).toBe(false);
    expect(isPublicFile({ ...file, size: -1 })).toBe(false);
    expect(isPublicFile({ ...file, size: 1.5 })).toBe(false);
    expect(isPublicFile({ ...file, contentType: "x".repeat(129) })).toBe(false);
    expect(isPublicFile(null)).toBe(false);
  });

  it("accepts metadata + github when both are well-formed", () => {
    const github = {
      repo: "buildinternet/uploads",
      kind: "pull",
      number: 142,
      url: "https://github.com/buildinternet/uploads/pull/142",
      avatarUrl: "https://api.uploads.sh/public/github/avatars/buildinternet",
    } as const;
    const metadata = { "gh.repo": "buildinternet/uploads", "gh.kind": "pull", "gh.number": "142" };
    expect(isPublicFile({ ...file, metadata, github })).toBe(true);
  });

  it("accepts loopback http avatarUrl for local dev but rejects arbitrary http", () => {
    const base = {
      repo: "buildinternet/uploads",
      kind: "pull" as const,
      number: 142,
      url: "https://github.com/buildinternet/uploads/pull/142",
    };
    expect(
      isPublicFile({
        ...file,
        github: {
          ...base,
          avatarUrl: "http://localhost:8787/public/github/avatars/buildinternet",
        },
      }),
    ).toBe(true);
    expect(
      isPublicFile({
        ...file,
        github: { ...base, avatarUrl: "http://evil.example/avatar.png" },
      }),
    ).toBe(false);
  });

  it("rejects malformed metadata maps", () => {
    expect(isPublicFile({ ...file, metadata: {} })).toBe(false);
    expect(isPublicFile({ ...file, metadata: { "Bad Key": "x" } })).toBe(false);
    expect(isPublicFile({ ...file, metadata: { ok: "x".repeat(513) } })).toBe(false);
    const tooManyKeys = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, "v"]));
    expect(isPublicFile({ ...file, metadata: tooManyKeys })).toBe(false);
  });

  it("rejects malformed github contexts", () => {
    const base = {
      repo: "buildinternet/uploads",
      kind: "pull",
      number: 142,
      url: "https://github.com/buildinternet/uploads/pull/142",
    };
    expect(isPublicFile({ ...file, github: { ...base, kind: "commit" } })).toBe(false);
    expect(isPublicFile({ ...file, github: { ...base, number: 0 } })).toBe(false);
    expect(
      isPublicFile({ ...file, github: { ...base, url: "http://github.com/x/y/pull/1" } }),
    ).toBe(false);
  });

  it("accepts optional modified and github.title", () => {
    expect(
      isPublicFile({
        ...file,
        modified: "2026-07-14T12:00:00.000Z",
        github: {
          repo: "o/r",
          kind: "pull",
          number: 1,
          url: "https://github.com/o/r/pull/1",
          title: "Fix the thing",
        },
      }),
    ).toBe(true);
  });

  it("rejects overlong github.title and bad modified", () => {
    expect(
      isPublicFile({
        ...file,
        github: {
          repo: "o/r",
          kind: "pull",
          number: 1,
          url: "https://github.com/o/r/pull/1",
          title: "x".repeat(513),
        },
      }),
    ).toBe(false);
    expect(isPublicFile({ ...file, modified: "not-a-date" })).toBe(false);
  });
});

describe("shouldShowModified", () => {
  it("is false when modified missing or within 60s on the same UTC day", () => {
    expect(shouldShowModified("2026-07-01T00:00:00.000Z", null)).toBe(false);
    expect(shouldShowModified("2026-07-01T00:00:00.000Z", "2026-07-01T00:00:30.000Z")).toBe(false);
  });
  it("is true when day differs or delta > 60s", () => {
    expect(shouldShowModified("2026-07-01T00:00:00.000Z", "2026-07-02T00:00:00.000Z")).toBe(true);
    expect(shouldShowModified("2026-07-01T00:00:00.000Z", "2026-07-01T00:02:00.000Z")).toBe(true);
    // Midnight boundary: delta 20s but different UTC days → still show modified.
    expect(shouldShowModified("2026-07-01T23:59:50.000Z", "2026-07-02T00:00:10.000Z")).toBe(true);
  });
});

describe("formatFileDate", () => {
  it("formats date-only and withTime; returns null for invalid input", () => {
    expect(formatFileDate("2026-07-01T15:30:00.000Z")).toMatch(/Jul/);
    expect(formatFileDate("2026-07-01T15:30:00.000Z", { withTime: true })).toMatch(/Jul/);
    expect(formatFileDate("not-a-date")).toBe(null);
  });
});

describe("sameUtcDay", () => {
  it("compares UTC calendar days", () => {
    expect(sameUtcDay("2026-07-01T00:00:00.000Z", "2026-07-01T23:59:59.000Z")).toBe(true);
    expect(sameUtcDay("2026-07-01T00:00:00.000Z", "2026-07-02T00:00:00.000Z")).toBe(false);
    expect(sameUtcDay("not-a-date", "2026-07-01T00:00:00.000Z")).toBe(false);
  });
});

describe("key safety + path building", () => {
  it("rejects traversal, absolute, empty, and over-long keys", () => {
    expect(isSafeKey("f/AbC123/logo.png")).toBe(true);
    expect(isSafeKey("../etc/passwd")).toBe(false);
    expect(isSafeKey("a/../b")).toBe(false);
    expect(isSafeKey("/leading")).toBe(false);
    expect(isSafeKey("")).toBe(false);
    expect(isSafeKey("x".repeat(1025))).toBe(false);
  });

  it("URL-encodes each key segment but preserves the slashes", () => {
    expect(filePath("acme", "f/My Shot#1.png")).toBe("/f/acme/f/My%20Shot%231.png");
  });

  it("builds the absolute download-route URL, encoding each key segment", () => {
    // `?download=1` query flag (Task 3), not a `/download` suffix — a static
    // suffix after the greedy key route param would be ambiguous.
    expect(fileDownloadUrl("https://api.uploads.sh", "acme", "f/My Shot#1.png")).toBe(
      "https://api.uploads.sh/public/files/acme/f/My%20Shot%231.png?download=1",
    );
  });
});

describe("fileKind", () => {
  it("maps images and videos, treats svg as unsupported, else file", () => {
    expect(fileKind("image/png")).toBe("image");
    expect(fileKind("video/mp4")).toBe("video");
    expect(fileKind("image/svg+xml")).toBe("unsupported");
    expect(fileKind("application/pdf")).toBe("file");
  });
});

describe("formatBytes", () => {
  it("renders human sizes with decimal SI units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(20_000)).toBe("20 KB");
    expect(formatBytes(1_500_000)).toBe("1.5 MB");
    expect(formatBytes(250_000_000)).toBe("250 MB");
  });
});

describe("fetchPublicFile", () => {
  it("returns ok for a valid DTO and calls the single-object endpoint", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => Response.json(file));
    const result = await fetchPublicFile("acme", "screenshots/shot.png", {
      origin: "https://api.uploads.sh",
      fetch: fetcher,
    });
    expect(result).toEqual({ status: "ok", file: { ...file, modified: null } });
    expect(String(fetcher.mock.calls[0][0])).toBe(
      "https://api.uploads.sh/public/files/acme/screenshots/shot.png",
    );
  });

  it("short-circuits bad workspace/key without a network call", async () => {
    const fetcher = vi.fn();
    expect(
      await fetchPublicFile("bad ws", "k", { origin: "https://api.uploads.sh", fetch: fetcher }),
    ).toEqual({ status: "not_found" });
    expect(
      await fetchPublicFile("acme", "../escape", {
        origin: "https://api.uploads.sh",
        fetch: fetcher,
      }),
    ).toEqual({ status: "not_found" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps 404 to not_found and other failures to unavailable", async () => {
    expect(
      await fetchPublicFile("acme", "k.png", {
        origin: "https://api.uploads.sh",
        fetch: async () => new Response(null, { status: 404 }),
      }),
    ).toEqual({ status: "not_found" });
    expect(
      await fetchPublicFile("acme", "k.png", {
        origin: "https://api.uploads.sh",
        fetch: async () => new Response("nope", { status: 503 }),
      }),
    ).toEqual({ status: "unavailable" });
  });

  it("maps a well-formed 401 auth_required body to auth_required", async () => {
    const body = { error: { code: "auth_required", message: "sign in to view this file" } };
    expect(
      await fetchPublicFile("acme", "k.png", {
        origin: "https://api.uploads.sh",
        fetch: async () => Response.json(body, { status: 401 }),
      }),
    ).toEqual({ status: "auth_required" });
  });

  it("treats a malformed or wrong-code 401 body as unavailable", async () => {
    expect(
      await fetchPublicFile("acme", "k.png", {
        origin: "https://api.uploads.sh",
        fetch: async () => new Response("nope", { status: 401 }),
      }),
    ).toEqual({ status: "unavailable" });
    expect(
      await fetchPublicFile("acme", "k.png", {
        origin: "https://api.uploads.sh",
        fetch: async () =>
          Response.json({ error: { code: "other", message: "x" } }, { status: 401 }),
      }),
    ).toEqual({ status: "unavailable" });
    expect(
      await fetchPublicFile("acme", "k.png", {
        origin: "https://api.uploads.sh",
        fetch: async () => Response.json({ nope: true }, { status: 401 }),
      }),
    ).toEqual({ status: "unavailable" });
  });

  it("refuses non-loopback plaintext origins but allows loopback dev", async () => {
    const fetcher = vi.fn(async () => Response.json(file));
    expect(
      await fetchPublicFile("acme", "k.png", { origin: "http://evil.test", fetch: fetcher }),
    ).toEqual({ status: "unavailable" });
    expect(
      (await fetchPublicFile("acme", "k.png", { origin: "http://127.0.0.1:8787", fetch: fetcher }))
        .status,
    ).toBe("ok");
  });

  it("exposes a poster url for a video that has one", async () => {
    const withPoster = {
      ...file,
      contentType: "video/mp4",
      posterUrl: "https://storage.uploads.sh/acme/_internal/posters/clip.mp4.jpg",
      videoDimensions: { width: 1920, height: 1080 },
    };
    const fetcher = vi.fn(async () => Response.json(withPoster));
    const result = await fetchPublicFile("acme", "clip.mp4", {
      origin: "https://api.uploads.sh",
      fetch: fetcher,
    });
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.file.posterUrl).toBe(
      "https://storage.uploads.sh/acme/_internal/posters/clip.mp4.jpg",
    );
    expect(isPublicFile(withPoster)).toBe(true);
  });

  it("omits the poster url when the video has none", async () => {
    const withoutPoster = { ...file, contentType: "video/mp4" };
    const fetcher = vi.fn(async () => Response.json(withoutPoster));
    const result = await fetchPublicFile("acme", "clip.mp4", {
      origin: "https://api.uploads.sh",
      fetch: fetcher,
    });
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.file.posterUrl).toBeUndefined();
    // A response that fabricates a non-https/malformed posterUrl must fail validation
    // rather than silently rendering an attacker-controlled image.
    expect(isPublicFile({ ...withoutPoster, posterUrl: "javascript:alert(1)" })).toBe(false);
  });

  it("exposes dimensions for aspect-ratio boxing", async () => {
    const withDims = {
      ...file,
      contentType: "video/mp4",
      videoDimensions: { width: 1280, height: 720 },
    };
    const fetcher = vi.fn(async () => Response.json(withDims));
    const result = await fetchPublicFile("acme", "clip.mp4", {
      origin: "https://api.uploads.sh",
      fetch: fetcher,
    });
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.file.videoDimensions).toEqual({
      width: 1280,
      height: 720,
    });
    // Non-numeric or missing width/height must not produce a videoDimensions object.
    expect(isPublicFile({ ...file, videoDimensions: { width: "1280", height: 720 } })).toBe(false);
    const { videoDimensions: _omit, ...noDims } = withDims;
    expect(isPublicFile(noDims)).toBe(true);
  });

  it("accepts a well-formed before/after counterpart (issue #420)", () => {
    const withCounterpart = {
      ...file,
      counterpart: {
        key: "gh/acme/web/pull/12/hero-after.webp",
        url: "https://storage.uploads.sh/acme/gh/acme/web/pull/12/hero-after.webp",
        state: "after",
      },
    };
    expect(isPublicFile(withCounterpart)).toBe(true);
    const { counterpart: _omit, ...noCounterpart } = withCounterpart;
    expect(isPublicFile(noCounterpart)).toBe(true);
  });

  it("rejects a malformed counterpart", () => {
    expect(
      isPublicFile({ ...file, counterpart: { key: "x", url: "https://x", state: "sideways" } }),
    ).toBe(false);
    expect(
      isPublicFile({
        ...file,
        counterpart: { key: "x", url: "javascript:alert(1)", state: "before" },
      }),
    ).toBe(false);
    expect(isPublicFile({ ...file, counterpart: { url: "https://x", state: "before" } })).toBe(
      false,
    );
  });
});
