import { describe, expect, it } from "vitest";
import { noProjectContextNudge } from "../src/project-context-nudge.js";

// Mirrors the grouping rules in apps/api projectLabelFromMeta (#692/#694):
// the nudge fires exactly when a shot would land in the "local dev" or
// "Other" fallback buckets on the screenshots page.
describe("noProjectContextNudge", () => {
  it("fires for a path-tagged shot whose only origin is a local host", () => {
    const note = noProjectContextNudge({ path: "/admin", url: "http://localhost:3000/admin" });
    expect(note).toContain('"local dev"');
    expect(note).toContain("--app");
  });

  it("fires for a path-tagged shot with no url at all, naming the Other bucket", () => {
    const note = noProjectContextNudge({ path: "/admin" });
    expect(note).toContain('"Other"');
  });

  it("covers all local-origin spellings", () => {
    for (const url of [
      "https://uploads.localhost/x",
      "http://127.0.0.1:8788/x",
      "http://0.0.0.0:4321/x",
      "http://[::1]:3000/x",
    ]) {
      expect(noProjectContextNudge({ path: "/x", url })).toBeDefined();
    }
  });

  it("stays silent when any project context exists", () => {
    expect(
      noProjectContextNudge({ path: "/x", url: "http://localhost:3000/x", repo: "o/r" }),
    ).toBeUndefined();
    expect(
      noProjectContextNudge({ path: "/x", url: "http://localhost:3000/x", "gh.repo": "o/r" }),
    ).toBeUndefined();
    expect(
      noProjectContextNudge({ path: "/x", url: "http://localhost:3000/x", app: "web" }),
    ).toBeUndefined();
  });

  it("stays silent for real hosts, non-page uploads, and undefined meta", () => {
    expect(noProjectContextNudge({ path: "/x", url: "https://x.dev/x" })).toBeUndefined();
    expect(noProjectContextNudge({ url: "http://localhost:3000/x" })).toBeUndefined();
    expect(noProjectContextNudge(undefined)).toBeUndefined();
    expect(noProjectContextNudge({})).toBeUndefined();
  });

  it("treats an unparseable url as no url", () => {
    expect(noProjectContextNudge({ path: "/x", url: "not a url" })).toContain('"Other"');
  });
});
