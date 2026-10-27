import { describe, expect, it } from "vitest";
import {
  matchingSkipLabel,
  requirementChecklist,
  skipLabelOnPr,
  surfaceOf,
} from "./github-check-requirements";
import { FakeKv } from "../test/fake-kv";

describe("surfaceOf", () => {
  it("prefers the classifier's label", () => {
    expect(
      surfaceOf({ "ai.surface": "mobile", "image.width": "2880", "image.height": "1800" }),
    ).toBe("mobile");
  });

  it("falls back to the frame's shape", () => {
    expect(surfaceOf({ "image.width": "1170", "image.height": "2532" })).toBe("mobile");
    expect(surfaceOf({ "video.width": "1920", "video.height": "1080" })).toBe("desktop");
    expect(surfaceOf({ "ai.surface": "tablet", "image.width": "800", "image.height": "800" })).toBe(
      null,
    );
    expect(surfaceOf(undefined)).toBe(null);
  });
});

describe("requirementChecklist", () => {
  it("evaluates each requirement in order", () => {
    expect(
      requirementChecklist(
        ["uploads", "before-after", "desktop", "mobile"],
        [
          {
            contentType: "image/png",
            meta: { state: "before", "image.width": "1440", "image.height": "900" },
          },
          { contentType: "video/mp4", meta: { state: "after" } },
        ],
      ),
    ).toEqual([
      { label: "Uploads", met: true },
      { label: "Before and after", met: true },
      { label: "Desktop", met: true },
      { label: "Mobile", met: false },
    ]);
  });

  it("counts galleries and held images or videos as uploads", () => {
    expect(requirementChecklist(["uploads"], [], 1)).toEqual([{ label: "Uploads", met: true }]);
    expect(requirementChecklist(["uploads"], [], 0)).toEqual([{ label: "Uploads", met: false }]);
  });

  it("ignores a PDF, log, or JSON file", () => {
    expect(
      requirementChecklist(
        ["uploads", "before-after", "desktop", "mobile"],
        [
          {
            contentType: "application/pdf",
            meta: { state: "before", "image.width": "1440", "image.height": "900" },
          },
          {
            contentType: "text/plain",
            name: "run.log",
            meta: { state: "after", "ai.surface": "mobile" },
          },
          { contentType: "application/json", meta: { state: "before", "ai.surface": "desktop" } },
        ],
      ),
    ).toEqual([
      { label: "Uploads", met: false },
      { label: "Before and after", met: false },
      { label: "Desktop", met: false },
      { label: "Mobile", met: false },
    ]);
    expect(
      requirementChecklist(
        ["uploads", "before-after"],
        [
          { contentType: "application/pdf", meta: { state: "before" } },
          { contentType: "image/png", meta: { state: "after" } },
        ],
      ),
    ).toEqual([
      { label: "Uploads", met: true },
      { label: "Before and after", met: false },
    ]);
    expect(
      requirementChecklist(
        ["uploads"],
        [{ contentType: "application/octet-stream", name: "shot.png" }],
      ),
    ).toEqual([{ label: "Uploads", met: true }]);
  });
});

describe("matchingSkipLabel", () => {
  it("matches case-insensitively and returns the PR's spelling", () => {
    expect(matchingSkipLabel(["bug", "Skip-Uploads"], ["skip-uploads"])).toBe("Skip-Uploads");
    expect(matchingSkipLabel(["bug"], ["skip-uploads"])).toBe(null);
  });
});

describe("skipLabelOnPr", () => {
  const TARGET = { repo: "acme/web", kind: "pull" as const, num: 12 };
  function env() {
    const kv = new FakeKv();
    kv.store.set("ghinst:acme/web", { value: "42" });
    kv.store.set("ghtok:42", { value: "tok" });
    return {
      GITHUB_CACHE: kv,
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "unused",
      GITHUB_APP_HOME_INSTALLATION_ID: "777",
    } as unknown as Env;
  }

  it("reads the PR's labels", async () => {
    const fetchImpl = (async () =>
      Response.json([{ name: "design" }, { name: "Skip-Uploads" }])) as unknown as typeof fetch;
    expect(await skipLabelOnPr(env(), TARGET, ["skip-uploads"], fetchImpl)).toBe("Skip-Uploads");
  });

  it("keeps the requirement when GitHub fails", async () => {
    const fetchImpl = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    expect(await skipLabelOnPr(env(), TARGET, ["skip-uploads"], fetchImpl)).toBe(null);
  });
});
