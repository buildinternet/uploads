import { describe, expect, it } from "vitest";
import type { GallerySummary, OwnerFeedDto } from "./api-client";
import {
  buildLinkRows,
  chunkRefs,
  deleteConfirmText,
  formatLinkDate,
  galleryLinkRow,
  itemsLabel,
  liveLinkLabel,
  liveLinkRow,
  repoScopeLabel,
  sourceLabel,
  titleRefs,
} from "./workspace-links";

function feed(over: Record<string, unknown> = {}): OwnerFeedDto {
  return {
    id: "feed_a",
    url: "https://uploads.sh/c/feed_a",
    workspace: "acme",
    repo: "acme/web",
    path: null,
    number: 12,
    kind: "pull",
    title: "acme/web #12",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
    source: "comment",
    ...over,
  } as unknown as OwnerFeedDto;
}

function gallery(over: Partial<GallerySummary> = {}): GallerySummary {
  return {
    id: "gal_a",
    url: "https://uploads.sh/g/gal_a",
    title: "Release",
    description: null,
    coverItemId: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-10-03T00:00:00Z",
    itemCount: 3,
    references: [],
    previewUrl: null,
    version: 2,
    ...over,
  };
}

describe("liveLinkRow", () => {
  it("scopes a PR link and builds its owner/repo#n ref", () => {
    const row = liveLinkRow(feed());
    expect(row).toMatchObject({ type: "live", scope: "pull", number: 12, ref: "acme/web#12" });
  });

  it("scopes issue and repo links", () => {
    expect(liveLinkRow(feed({ kind: "issue", number: 7 })).scope).toBe("issue");
    const repo = liveLinkRow(feed({ kind: null, number: null }));
    expect(repo.scope).toBe("repo");
    expect(repo.ref).toBeNull();
  });

  it("treats a numbered legacy row with no kind as a PR", () => {
    expect(liveLinkRow(feed({ kind: null, number: 3 })).scope).toBe("pull");
  });

  it("drops an unknown source", () => {
    expect(liveLinkRow(feed({ source: "other" })).source).toBeNull();
    expect(liveLinkRow(feed({ source: undefined })).source).toBeNull();
  });
});

describe("galleryLinkRow", () => {
  it("keeps the version, or null when the API predates it", () => {
    expect(galleryLinkRow(gallery()).version).toBe(2);
    expect(galleryLinkRow(gallery({ version: undefined })).version).toBeNull();
  });

  it("normalizes a blank description to null", () => {
    expect(galleryLinkRow(gallery({ description: "   " })).description).toBeNull();
  });
});

describe("buildLinkRows", () => {
  it("merges both kinds newest first", () => {
    const rows = buildLinkRows(
      [
        feed({ id: "f1", updatedAt: "2026-10-01T00:00:00Z" }),
        feed({ id: "f2", updatedAt: "2026-10-05T00:00:00Z" }),
      ],
      [gallery({ id: "g1", updatedAt: "2026-10-03T00:00:00Z" })],
    );
    expect(rows.map((r) => `${r.type}:${r.id}`)).toEqual(["live:f2", "gallery:g1", "live:f1"]);
  });

  it("orders equal timestamps by key so SSR and client agree", () => {
    const at = "2026-10-01T00:00:00Z";
    const rows = buildLinkRows(
      [feed({ id: "b", updatedAt: at })],
      [gallery({ id: "a", updatedAt: at })],
    );
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("titleRefs and chunkRefs", () => {
  it("collects distinct PR/issue refs and skips repo links and galleries", () => {
    const rows = buildLinkRows(
      [
        feed({ id: "1", number: 1 }),
        feed({ id: "2", number: 1 }),
        feed({ id: "3", number: null, kind: null }),
        feed({ id: "4", number: 2, kind: "issue" }),
      ],
      [gallery()],
    );
    expect(titleRefs(rows).sort()).toEqual(["acme/web#1", "acme/web#2"]);
  });

  it("batches refs at the titles route's per-request cap", () => {
    const refs = Array.from({ length: 45 }, (_, i) => `acme/web#${i + 1}`);
    expect(chunkRefs(refs).map((batch) => batch.length)).toEqual([20, 20, 5]);
    expect(chunkRefs(refs).flat()).toEqual(refs);
    expect(chunkRefs([])).toEqual([]);
  });
});

describe("labels", () => {
  it("builds a PrLabel input from the titles map", () => {
    const row = liveLinkRow(feed());
    expect(
      liveLinkLabel(row, { "acme/web#12": { title: "Fix nav", state: "merged", kind: "pull" } }),
    ).toEqual({ ghRef: "acme/web#12", title: "Fix nav", state: "merged", kind: "pull" });
    expect(liveLinkLabel(row, {})).toEqual({
      ghRef: "acme/web#12",
      title: null,
      state: null,
      kind: "pull",
    });
    expect(liveLinkLabel(row, { "acme/web#12": null })?.title).toBeNull();
  });

  it("has no PrLabel for a repo link, which shows owner/repo", () => {
    const repo = liveLinkRow(feed({ number: null, kind: null }));
    expect(liveLinkLabel(repo, {})).toBeNull();
    expect(repoScopeLabel(repo)).toBe("acme/web");
    expect(repoScopeLabel(liveLinkRow(feed({ number: null, kind: null, path: "/settings" })))).toBe(
      "acme/web · /settings",
    );
  });

  it("names the source", () => {
    expect(sourceLabel(liveLinkRow(feed()))).toBe("From PR comment");
    expect(sourceLabel(liveLinkRow(feed({ kind: "issue" })))).toBe("From issue comment");
    expect(sourceLabel(liveLinkRow(feed({ source: "user" })))).toBe("Created by you");
    expect(sourceLabel(liveLinkRow(feed({ source: null })))).toBe("");
  });

  it("uses the spec's confirm copy for a PR link", () => {
    expect(deleteConfirmText(liveLinkRow(feed()))).toBe(
      "The old link stops working. The PR comment gets a new link on its next update.",
    );
    expect(deleteConfirmText(liveLinkRow(feed({ number: null, kind: null })))).toBe(
      "The old link stops working.",
    );
    expect(deleteConfirmText(galleryLinkRow(gallery()))).toBe(
      "The gallery’s public link stops working. Its files stay in Storage.",
    );
  });

  it("formats counts and dates deterministically", () => {
    expect(itemsLabel(null)).toBe("empty");
    expect(itemsLabel(0)).toBe("empty");
    expect(itemsLabel(1)).toBe("1 item");
    expect(itemsLabel(4)).toBe("4 items");
    expect(formatLinkDate("2026-10-04T23:30:00-07:00")).toBe("Oct 5, 2026");
    expect(formatLinkDate("not a date")).toBe("not a date");
  });
});
