import { describe, expect, it } from "vitest";
import {
  aiNotesFor,
  evaluateAiNotes,
  identicalBeforeAfterNote,
  readyScreenNote,
} from "./github-check-ai-notes";

describe("readyScreenNote", () => {
  it("warns on an after file that isn't ready", () => {
    expect(
      readyScreenNote([
        { name: "after.png", meta: { state: "after", "ai.ready": "loading" } },
        { name: "after-2.png", meta: { state: "after", "ai.ready": "ready" } },
      ]),
    ).toEqual({
      label: "An after screen may not show the change",
      outcome: "warning",
      details: ["`after.png` looks like it is still loading"],
    });
  });

  it("never judges a before or an unmarked file", () => {
    expect(
      readyScreenNote([
        { name: "before.png", meta: { state: "before", "ai.ready": "error" } },
        { name: "shot.png", meta: { "ai.ready": "blank" } },
      ]),
    ).toMatchObject({ outcome: "skipped", details: ["No files are marked as after."] });
  });

  it("skips when no after file is labelled yet, and passes ready ones", () => {
    expect(readyScreenNote([{ name: "a.png", meta: { state: "after" } }])).toMatchObject({
      outcome: "skipped",
    });
    expect(
      readyScreenNote([{ name: "a.png", meta: { state: "after", "ai.ready": "ready" } }]),
    ).toEqual({ label: "After screens look ready", outcome: "ok", details: [] });
  });

  it("keeps a backtick in a name from breaking the code span", () => {
    expect(
      readyScreenNote([{ name: "a`b.png", meta: { state: "after", "ai.ready": "error" } }]).details,
    ).toEqual(["`a'b.png` shows an error instead of the screen"]);
  });
});

describe("identicalBeforeAfterNote", () => {
  it("warns when a before and an after share a pHash", () => {
    expect(
      identicalBeforeAfterNote([
        { name: "before.png", meta: { state: "before", "ai.phash": "abc" } },
        { name: "after.png", meta: { state: "after", "ai.phash": "abc" } },
      ]),
    ).toEqual({
      label: "Before and after look the same",
      outcome: "warning",
      details: ["`before.png` and `after.png` look the same"],
    });
  });

  it("passes different pictures", () => {
    expect(
      identicalBeforeAfterNote([
        { name: "before.png", meta: { state: "before", "ai.phash": "abc" } },
        { name: "after.png", meta: { state: "after", "ai.phash": "def" } },
      ]),
    ).toMatchObject({ outcome: "ok" });
  });

  it("skips without a pair or without hashes", () => {
    expect(
      identicalBeforeAfterNote([{ name: "after.png", meta: { state: "after", "ai.phash": "a" } }]),
    ).toMatchObject({ outcome: "skipped" });
    expect(
      identicalBeforeAfterNote([
        { name: "before.mp4", meta: { state: "before" } },
        { name: "after.mp4", meta: { state: "after" } },
      ]),
    ).toMatchObject({ outcome: "skipped" });
  });
});

describe("aiNotesFor", () => {
  it("returns the enabled notes in config order", () => {
    expect(aiNotesFor(["ready-screen", "identical-before-after"], []).map((n) => n.label)).toEqual([
      "After screens not checked",
      "Before and after not compared",
    ]);
    expect(aiNotesFor([], [])).toEqual([]);
  });
});

describe("evaluateAiNotes", () => {
  it("fails open: a failed metadata read drops the notes instead of throwing", async () => {
    const broken = {
      prepare() {
        throw new Error("d1 down");
      },
    };
    const env = { DB: broken } as unknown as Env;
    await expect(
      evaluateAiNotes(
        env,
        "ws",
        { repo: "acme/web", kind: "pull", num: 1 },
        ["ready-screen"],
        ["gh/acme/web/pull/1/after.png"],
      ),
    ).resolves.toEqual([]);
  });
});
