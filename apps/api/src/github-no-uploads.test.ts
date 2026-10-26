import { describe, expect, it } from "vitest";
import {
  changedUiFiles,
  DEFAULT_UI_PATHS,
  describeUiFiles,
  noUploadsCommentBody,
  uiPathMatcher,
} from "./github-no-uploads";
import { FakeKv } from "../test/fake-kv";

describe("uiPathMatcher", () => {
  it("matches globs the way a .gitignore reader would expect", () => {
    const m = uiPathMatcher(["apps/web/**", "*.css", "src/components/", "packages/ui"]);
    expect(m("apps/web/src/pages/file.astro")).toBe(true);
    expect(m("styles/base.css")).toBe(true);
    expect(m("base.css")).toBe(true);
    expect(m("src/components/Button.tsx")).toBe(true);
    expect(m("packages/ui/index.ts")).toBe(true);
    expect(m("packages/ui")).toBe(true);
    expect(m("apps/api/src/index.ts")).toBe(false);
    expect(m("packages/ui-kit/index.ts")).toBe(false);
  });

  it("keeps * inside one directory and ** across them", () => {
    const m = uiPathMatcher(["apps/*/pages/*.astro", "src/**/*.tsx"]);
    expect(m("apps/web/pages/index.astro")).toBe(true);
    expect(m("apps/web/pages/nested/index.astro")).toBe(false);
    expect(m("src/App.tsx")).toBe(true);
    expect(m("src/a/b/App.tsx")).toBe(true);
    expect(m("src/a/b/App.ts")).toBe(false);
  });

  it("treats regex characters literally", () => {
    const m = uiPathMatcher(["app/(marketing)/page.tsx"]);
    expect(m("app/(marketing)/page.tsx")).toBe(true);
    expect(m("app/marketing/page.tsx")).toBe(false);
  });
});

describe("DEFAULT_UI_PATHS", () => {
  it("matches what the CLI's pre-PR hook counts as UI", () => {
    const matches = uiPathMatcher(DEFAULT_UI_PATHS);
    for (const f of ["a.astro", "src/B.tsx", "x/y.jsx", "c.vue", "d.svelte", "e.html"]) {
      expect(matches(f)).toBe(true);
    }
    for (const f of ["s.css", "s.scss", "s.less", "email/welcome.ts", "apps/email/x.ts"]) {
      expect(matches(f)).toBe(true);
    }
    for (const f of ["src/a.ts", "README.md", "emails.ts", "package.json"]) {
      expect(matches(f)).toBe(false);
    }
  });
});

describe("noUploadsCommentBody", () => {
  it("names the first files and the PR number", () => {
    const body = noUploadsCommentBody(
      "<!-- marker -->",
      { num: 12 },
      ["a.astro", "b.css", "c.tsx", "d.tsx"],
      { importsAttachments: true },
    );
    expect(body.startsWith("<!-- marker -->\n**No uploads on this PR yet**")).toBe(true);
    expect(body).toContain(
      "<code>a.astro</code>, <code>b.css</code>, <code>c.tsx</code> and 1 more",
    );
    expect(body).toContain("<code>uploads put before.png after.png --pr 12</code>");
    expect(body).toContain("drag images into the PR description");
    expect(body).toContain("Settings → GitHub");
  });

  it("offers drag-and-drop without promising an import when imports are off", () => {
    const body = noUploadsCommentBody("<!-- m -->", { num: 1 }, ["a.css"], {
      importsAttachments: false,
    });
    expect(body).toContain("drag images into the PR description\n");
    expect(body).not.toContain("imported");
  });

  it("escapes file names", () => {
    expect(describeUiFiles(["<x>.css"])).toBe("<code>&lt;x&gt;.css</code>");
    expect(describeUiFiles(["a", "b"])).toBe("<code>a</code> and <code>b</code>");
  });
});

describe("changedUiFiles", () => {
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

  it("returns the PR's files that match, across pages", async () => {
    const urls: string[] = [];
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `apps/api/f${i}.ts` }));
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("page=1")) return Response.json(page1);
      return Response.json([{ filename: "apps/web/src/page.astro" }, { filename: "README.md" }]);
    }) as typeof fetch;
    await expect(changedUiFiles(env(), TARGET, ["apps/web/**"], fetchImpl)).resolves.toEqual([
      "apps/web/src/page.astro",
    ]);
    expect(urls[0]).toBe(
      "https://api.github.com/repos/acme/web/pulls/12/files?per_page=100&page=1",
    );
    expect(urls).toHaveLength(2);
  });

  it("leaves out deleted files and moves without edits", async () => {
    const fetchImpl = (async () =>
      Response.json([
        { filename: "apps/web/gone.css", status: "removed", changes: 12 },
        { filename: "apps/web/moved.tsx", status: "renamed", changes: 0 },
        { filename: "apps/web/renamed.tsx", status: "renamed", changes: 3 },
        { filename: "apps/web/edited.astro", status: "modified", changes: 2 },
      ])) as unknown as typeof fetch;
    await expect(changedUiFiles(env(), TARGET, ["apps/web/**"], fetchImpl)).resolves.toEqual([
      "apps/web/renamed.tsx",
      "apps/web/edited.astro",
    ]);
  });

  it("skips issues, empty uiPaths and GitHub failures", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("", { status: 500 });
    }) as typeof fetch;
    await expect(
      changedUiFiles(env(), { ...TARGET, kind: "issues" }, ["**"], fetchImpl),
    ).resolves.toEqual([]);
    await expect(changedUiFiles(env(), TARGET, [], fetchImpl)).resolves.toEqual([]);
    expect(calls).toBe(0);
    await expect(changedUiFiles(env(), TARGET, ["**"], fetchImpl)).resolves.toEqual([]);
  });
});
