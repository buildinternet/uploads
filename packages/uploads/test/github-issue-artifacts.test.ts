import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { UploadsClient } from "../src/client.js";
import { syncAttachmentsComment } from "../src/commands.js";
import type { GhTarget } from "../src/github.js";
import type { CommandRunner } from "../src/github-gh.js";
import {
  ISSUE_GALLERY_ARTIFACT_NAME,
  ISSUE_MEDIA_ARTIFACT_NAME,
  issueArtifactMediaBody,
  issueArtifactName,
  resolveIssueArtifacts,
  syncIssueArtifacts,
} from "../src/github-issue-artifacts.js";

const issue: GhTarget = { repo: "o/r", kind: "issues", num: 45 };
const pull: GhTarget = { repo: "o/r", kind: "pull", num: 45 };

const IMAGE = "https://embed.uploads.sh/acme/shot.webp";
const VIDEO = "https://storage.uploads.sh/acme/clip.mp4";
const GALLERY = "https://uploads.test/g/gal_example";

interface Call {
  args: string[];
  input?: string;
}

function methodOf(args: string[]): string {
  const i = args.indexOf("-X");
  return i === -1 ? "GET" : (args[i + 1] ?? "GET");
}

function endpointOf(args: string[]): string {
  return args.find((arg) => arg.startsWith("repos/")) ?? "";
}

function payloadOf(input?: string): { type?: string; name?: string; body?: string } {
  return input ? (JSON.parse(input) as { type?: string; name?: string; body?: string }) : {};
}

function isGalleryWrite(input?: string): boolean {
  const payload = payloadOf(input);
  if (payload.type === "link") return true;
  if (payload.type === undefined && payload.body?.startsWith("https://")) return true;
  return false;
}

/**
 * Mock `gh api` for the artifacts endpoint. `pages` are successive GET
 * responses (one per page request). Writes throw when `fail` says so.
 */
function artifactApi(opts: {
  pages?: { number: number; name: string; type?: string; body?: string }[][];
  fail?: "list" | "media" | "gallery";
}) {
  const calls: Call[] = [];
  const pages = opts.pages ?? [[]];
  let reads = 0;
  const run: CommandRunner = (_cmd, args, input) => {
    calls.push({ args, input });
    const endpoint = endpointOf(args);
    if (!endpoint.includes("/artifacts")) throw new Error(`unexpected endpoint: ${endpoint}`);
    if (args.includes("--attach")) throw new Error("must not pass --attach");
    const method = methodOf(args);
    if (method === "GET") {
      if (opts.fail === "list") throw new Error("HTTP 429");
      const page = pages[reads] ?? [];
      reads += 1;
      return JSON.stringify(page);
    }
    const gallery = isGalleryWrite(input);
    if (opts.fail === "media" && !gallery) throw new Error("HTTP 429");
    if (opts.fail === "gallery" && gallery) throw new Error("HTTP 429");
    return JSON.stringify({ number: 1 });
  };
  return { run, calls };
}

function writes(calls: Call[], method: "POST" | "PATCH") {
  return calls.filter((call) => methodOf(call.args) === method);
}

describe("resolveIssueArtifacts", () => {
  it("uses the call, then the repo file, then the workspace, then on", () => {
    expect(resolveIssueArtifacts({})).toBe(true);
    expect(resolveIssueArtifacts({ workspace: false })).toBe(false);
    expect(resolveIssueArtifacts({ workspace: false, repo: true })).toBe(true);
    expect(resolveIssueArtifacts({ repo: true, call: false })).toBe(false);
    expect(resolveIssueArtifacts({ call: true, repo: false, workspace: false })).toBe(true);
  });
});

describe("issueArtifactName", () => {
  it("strips parentheses and keeps the stable names free of them", () => {
    expect(issueArtifactName("plan (1).md")).toBe("plan 1.md");
    expect(ISSUE_MEDIA_ARTIFACT_NAME).not.toMatch(/[()]/);
    expect(ISSUE_GALLERY_ARTIFACT_NAME).not.toMatch(/[()]/);
    expect(issueArtifactName(ISSUE_MEDIA_ARTIFACT_NAME)).toBe(ISSUE_MEDIA_ARTIFACT_NAME);
  });
});

describe("issueArtifactMediaBody", () => {
  it("keeps uploads.sh image URLs and turns a video tag into a link", () => {
    const body = issueArtifactMediaBody(
      `<img alt="shot" src="${IMAGE}">\n<video src="${VIDEO}" controls></video>`,
    );
    expect(body).toContain(`src="${IMAGE}"`);
    expect(body).toContain(`[video](${VIDEO})`);
    expect(body).not.toContain("<video");
  });
});

describe("syncIssueArtifacts", () => {
  const commentBody = `<img alt="shot" src="${IMAGE}">\n<video src="${VIDEO}"></video>`;

  it("creates one generic artifact and does not copy bytes", () => {
    const { run, calls } = artifactApi({});
    const result = syncIssueArtifacts(issue, run, { commentBody });
    expect(result).toEqual({ media: "created" });
    const posts = writes(calls, "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.args).toContain(`repos/o/r/issues/45/artifacts`);
    expect(posts[0]!.args).not.toContain("--attach");
    const payload = payloadOf(posts[0]!.input);
    expect(payload.type).toBe("generic");
    expect(payload.name).toBe(ISSUE_MEDIA_ARTIFACT_NAME);
    expect(payload.name).not.toMatch(/[()]/);
    expect(payload.body).toContain(IMAGE);
    expect(payload.body).toContain(`[video](${VIDEO})`);
    expect(payload.body).not.toContain("<video");
  });

  it("updates an existing artifact in place by name", () => {
    const { run, calls } = artifactApi({
      pages: [
        [
          {
            number: 4,
            name: ISSUE_MEDIA_ARTIFACT_NAME,
            type: "generic",
            body: "old",
          },
        ],
      ],
    });
    const result = syncIssueArtifacts(issue, run, { commentBody: "new media" });
    expect(result).toEqual({ media: "updated" });
    expect(writes(calls, "POST")).toHaveLength(0);
    const patches = writes(calls, "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.args).toContain("repos/o/r/issues/45/artifacts/4");
    expect(payloadOf(patches[0]!.input)).toEqual({ body: "new media" });
  });

  it("skips the write when the body is already current", () => {
    const { run, calls } = artifactApi({
      pages: [[{ number: 4, name: ISSUE_MEDIA_ARTIFACT_NAME, body: "same" }]],
    });
    expect(syncIssueArtifacts(issue, run, { commentBody: "same" })).toEqual({});
    expect(writes(calls, "PATCH")).toHaveLength(0);
    expect(writes(calls, "POST")).toHaveLength(0);
  });

  it("creates or updates one link artifact for the gallery URL", () => {
    const created = artifactApi({});
    expect(syncIssueArtifacts(issue, created.run, { galleryUrl: GALLERY })).toEqual({
      gallery: "created",
    });
    const post = payloadOf(writes(created.calls, "POST")[0]!.input);
    expect(post).toEqual({ type: "link", name: ISSUE_GALLERY_ARTIFACT_NAME, body: GALLERY });
    expect(post.name).not.toMatch(/[()]/);

    const updated = artifactApi({
      pages: [
        [
          {
            number: 3,
            name: ISSUE_GALLERY_ARTIFACT_NAME,
            type: "link",
            body: "https://old.example/g",
          },
        ],
      ],
    });
    expect(syncIssueArtifacts(issue, updated.run, { galleryUrl: GALLERY })).toEqual({
      gallery: "updated",
    });
    expect(writes(updated.calls, "PATCH")[0]!.args).toContain("repos/o/r/issues/45/artifacts/3");
    expect(payloadOf(writes(updated.calls, "PATCH")[0]!.input)).toEqual({ body: GALLERY });
  });

  it("does not call GitHub for a pull request", () => {
    const { run, calls } = artifactApi({});
    expect(syncIssueArtifacts(pull, run, { commentBody: "media", galleryUrl: GALLERY })).toEqual(
      {},
    );
    expect(calls).toHaveLength(0);
  });

  it("warns and continues when the list or a write fails", () => {
    const listed = artifactApi({ fail: "list" });
    expect(
      syncIssueArtifacts(issue, listed.run, { commentBody: "media", galleryUrl: GALLERY }),
    ).toEqual({
      warning: expect.stringContaining("429"),
    });
    expect(writes(listed.calls, "POST")).toHaveLength(0);

    const mediaFailed = artifactApi({ fail: "media" });
    const result = syncIssueArtifacts(issue, mediaFailed.run, {
      commentBody: "media",
      galleryUrl: GALLERY,
    });
    expect(result.media).toBeUndefined();
    expect(result.gallery).toBe("created");
    expect(result.warning).toContain("429");
    expect(result.warning).toContain("issue artifact was not updated");
  });
});

function commentClient(
  items: { key: string; url: string; embedUrl?: string; size?: number }[],
  galleries: { id: string; title: string; url: string }[] = [],
): UploadsClient {
  return {
    listAll: async () => items,
    findGalleriesByReference: async () => ({ galleries, nextCursor: null }),
    getGallery: async (id: string) => ({ id, items: [] }),
    upsertGithubComment: async () => ({ posted: false, reason: "not_installed" }),
    resolveGhPrefix: async () => ({ mode: "plain" }),
    listHeld: async () => [],
  } as unknown as UploadsClient;
}

/** Runner for syncAttachmentsComment: comments succeed, artifacts are recorded. */
function commentRunner(root: string, opts: { failArtifactWrite?: boolean } = {}) {
  const calls: { args: string[]; input?: string }[] = [];
  const run: CommandRunner = (cmd, args, input) => {
    calls.push({ args, input });
    if (cmd === "git" && args[0] === "rev-parse") return `${root}\n`;
    if (cmd !== "gh") throw new Error(`unexpected command: ${cmd}`);
    const endpoint = endpointOf(args);
    if (endpoint.includes("/artifacts")) {
      if (methodOf(args) === "GET") return "[]";
      if (opts.failArtifactWrite) throw new Error("HTTP 429");
      return JSON.stringify({ number: 8 });
    }
    if (args.some((arg) => arg.includes("per_page=100"))) return "[]";
    return JSON.stringify({ id: 9 });
  };
  return { run, calls };
}

function repoWithConfig(yaml: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "uploads-issue-artifacts-"));
  if (yaml !== null) writeFileSync(join(root, ".uploads.yml"), yaml);
  return root;
}

const mediaItems = [
  {
    key: "gh/o/r/issues/45/shot.webp",
    url: "https://storage.uploads.sh/acme/shot.webp",
    embedUrl: IMAGE,
    size: 10,
  },
  {
    key: "gh/o/r/issues/45/clip.mp4",
    url: VIDEO,
    size: 20,
  },
];

describe("syncAttachmentsComment issue artifacts", () => {
  it("creates the media artifact by default", async () => {
    const root = repoWithConfig(null);
    const { run, calls } = commentRunner(root);
    const result = await syncAttachmentsComment(commentClient(mediaItems), issue, run, "test");
    expect(result.via).toBe("gh");
    expect(result.issueArtifact).toEqual({ media: "created" });
    const post = writes(calls, "POST").find((call) => endpointOf(call.args).includes("/artifacts"));
    expect(post).toBeDefined();
    const payload = payloadOf(post!.input);
    expect(payload.type).toBe("generic");
    expect(payload.name).toBe(ISSUE_MEDIA_ARTIFACT_NAME);
    expect(payload.body).toContain(IMAGE);
    expect(payload.body).toContain(VIDEO);
    expect(payload.body).not.toContain("<video");
    expect(post!.args).not.toContain("--attach");
  });

  it("skips when the repo, the workspace, or the call opts out", async () => {
    const repoOff = repoWithConfig("comment:\n  issueArtifacts: false\n");
    const repoRun = commentRunner(repoOff);
    const fromRepo = await syncAttachmentsComment(
      commentClient(mediaItems),
      issue,
      repoRun.run,
      "test",
    );
    expect(fromRepo.issueArtifact).toBeUndefined();
    expect(repoRun.calls.some((call) => endpointOf(call.args).includes("/artifacts"))).toBe(false);

    const wsOff = commentClient(mediaItems);
    (
      wsOff as unknown as { upsertGithubComment: UploadsClient["upsertGithubComment"] }
    ).upsertGithubComment = async () => ({
      posted: false,
      reason: "not_installed",
      issueArtifacts: false,
    });
    const wsRun = commentRunner(repoWithConfig(null));
    const fromWs = await syncAttachmentsComment(wsOff, issue, wsRun.run, "test");
    expect(fromWs.issueArtifact).toBeUndefined();

    const callOff = await syncAttachmentsComment(
      commentClient(mediaItems),
      issue,
      commentRunner(repoWithConfig("comment:\n  issueArtifacts: true\n")).run,
      "test",
      { issueArtifacts: false },
    );
    expect(callOff.issueArtifact).toBeUndefined();
  });

  it("reads comment.issueArtifacts from .uploads.yml and links the first gallery", async () => {
    const root = repoWithConfig("comment:\n  issueArtifacts: true\n");
    const { run, calls } = commentRunner(root);
    const result = await syncAttachmentsComment(
      commentClient(mediaItems, [
        { id: "g2", title: "Zebra", url: "https://uploads.test/g/zebra" },
        { id: "g1", title: "Alpha", url: "https://uploads.test/g/alpha" },
      ]),
      issue,
      run,
      "test",
    );
    expect(result.issueArtifact?.media).toBe("created");
    expect(result.issueArtifact?.gallery).toBe("created");
    const link = writes(calls, "POST")
      .map((call) => payloadOf(call.input))
      .find((payload) => payload.type === "link");
    expect(link).toEqual({
      type: "link",
      name: ISSUE_GALLERY_ARTIFACT_NAME,
      body: "https://uploads.test/g/alpha",
    });
  });

  it("does not create artifacts for a pull request", async () => {
    const root = repoWithConfig("comment:\n  issueArtifacts: true\n");
    const { run, calls } = commentRunner(root);
    const result = await syncAttachmentsComment(
      commentClient([
        {
          key: "gh/o/r/pull/45/shot.webp",
          url: "https://storage.uploads.sh/acme/shot.webp",
          embedUrl: IMAGE,
        },
      ]),
      pull,
      run,
      "test",
      { issueArtifacts: true },
    );
    expect(result.issueArtifact).toBeUndefined();
    expect(calls.some((call) => endpointOf(call.args).includes("/artifacts"))).toBe(false);
  });

  it("mirrors a bot-posted issue comment into an artifact", async () => {
    const root = repoWithConfig("comment:\n  issueArtifacts: true\n");
    const calls: { args: string[]; input?: string }[] = [];
    const marker = "<!-- uploads.sh:attachments ws=test -->";
    const run: CommandRunner = (cmd, args, input) => {
      calls.push({ args, input });
      if (cmd === "git" && args[0] === "rev-parse") return `${root}\n`;
      if (cmd !== "gh") throw new Error(`unexpected command: ${cmd}`);
      const endpoint = endpointOf(args);
      if (endpoint.includes("/artifacts")) {
        if (methodOf(args) === "GET") return "[]";
        return JSON.stringify({ number: 8 });
      }
      if (endpoint.includes("/comments")) {
        return JSON.stringify([{ id: 9, body: `${marker}\n<img alt="shot" src="${IMAGE}">` }]);
      }
      return JSON.stringify({ id: 9 });
    };
    const client = commentClient(
      [],
      [{ id: "g1", title: "Shots", url: "https://uploads.test/g/shots" }],
    );
    (
      client as unknown as { upsertGithubComment: UploadsClient["upsertGithubComment"] }
    ).upsertGithubComment = async () => ({ posted: true, action: "updated", count: 1 });
    const result = await syncAttachmentsComment(client, issue, run, "test");
    expect(result.via).toBe("bot");
    expect(result.issueArtifact).toEqual({ media: "created", gallery: "created" });
    const bodies = writes(calls, "POST").map((call) => payloadOf(call.input));
    expect(bodies).toContainEqual({
      type: "generic",
      name: ISSUE_MEDIA_ARTIFACT_NAME,
      body: `${marker}\n<img alt="shot" src="${IMAGE}">`,
    });
    expect(bodies).toContainEqual({
      type: "link",
      name: ISSUE_GALLERY_ARTIFACT_NAME,
      body: "https://uploads.test/g/shots",
    });
  });

  it("warns and still returns the comment when the artifact write fails", async () => {
    const root = repoWithConfig(null);
    const { run } = commentRunner(root, { failArtifactWrite: true });
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      const result = await syncAttachmentsComment(commentClient(mediaItems), issue, run, "test", {
        issueArtifacts: true,
      });
      expect(result.action).toBe("created");
      expect(result.issueArtifact?.warning).toContain("429");
      expect(result.issueArtifact?.media).toBeUndefined();
      expect(stderr.join("")).toContain("warning:");
      expect(stderr.join("")).toContain("429");
    } finally {
      spy.mockRestore();
    }
  });
});
