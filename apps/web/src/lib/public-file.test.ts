import { describe, expect, it, vi } from "vitest";
import {
  applyPublicFileHeaders,
  authRequiredFileCsp,
  fetchPublicFile,
  fileDownloadUrl,
  fileKind,
  filePath,
  formatBytes,
  isPublicFile,
  isSafeKey,
  PUBLIC_FILE_CSP,
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
    const headers = new Headers();
    applyPublicFileHeaders(headers);
    expect(headers.get("Content-Security-Policy")).toBe(PUBLIC_FILE_CSP);
    expect(headers.get("Cache-Control")).toBe("no-store");
    expect(headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
  });

  it("authRequiredFileCsp widens script-src/connect-src but keeps the rest locked down", () => {
    const csp = authRequiredFileCsp("https://api.uploads.sh");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("connect-src https://api.uploads.sh");
    expect(csp).toContain("'self'");
    expect(csp).toContain("https://cloudflareinsights.com");
    expect(csp).toContain("frame-ancestors 'none'");

    const headers = new Headers();
    applyPublicFileHeaders(headers, { csp });
    expect(headers.get("Content-Security-Policy")).toBe(csp);
    expect(headers.get("Cache-Control")).toBe("no-store");

    // Default call (no override) still gets the strict, script-free policy.
    const defaultHeaders = new Headers();
    applyPublicFileHeaders(defaultHeaders);
    expect(defaultHeaders.get("Content-Security-Policy")).toBe(PUBLIC_FILE_CSP);
  });

  it("widens script-src on the ok branch too — same posture as authRequiredFileCsp", () => {
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
    } as const;
    const metadata = { "gh.repo": "buildinternet/uploads", "gh.kind": "pull", "gh.number": "142" };
    expect(isPublicFile({ ...file, metadata, github })).toBe(true);
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
  it("renders human sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(20480)).toBe("20 KB");
    expect(formatBytes(1_500_000)).toBe("1.4 MB");
  });
});

describe("fetchPublicFile", () => {
  it("returns ok for a valid DTO and calls the single-object endpoint", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => Response.json(file));
    const result = await fetchPublicFile("acme", "screenshots/shot.png", {
      origin: "https://api.uploads.sh",
      fetch: fetcher,
    });
    expect(result).toEqual({ status: "ok", file: { ...file } });
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
});
