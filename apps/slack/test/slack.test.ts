import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/index";
import type { SlackEnv } from "../src/config";
import { formatBytes, parseShareUrl } from "../src/share";
import { signSlackRequest, verifySlackSignature } from "../src/slack/signature";
import { escapeMrkdwn, previewBlocks } from "../src/unfurl";

const SECRET = "test-signing-secret";
const TOKEN = "xoxb-test";
const WEB = "https://uploads.sh";

function nowTs(): string {
  return String(Math.floor(Date.now() / 1000));
}

/** Records waitUntil promises so tests can await the post-ack work. */
function executionCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext,
    settle: () => Promise.all(pending),
  };
}

/** Fake uploads-api: answers public read paths (pathname + search) from fixtures; anything else 404s. */
function fakeApi(fixtures: Record<string, unknown>) {
  const calls: string[] = [];
  const fetcher = {
    fetch: vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      calls.push(url.pathname + url.search);
      const body = fixtures[url.pathname + url.search] ?? fixtures[url.pathname];
      return body === undefined
        ? new Response(JSON.stringify({ error: "not_found" }), { status: 404 })
        : new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
    }),
  } as unknown as Fetcher;
  return { fetcher, calls };
}

/** Fake slack.com: records chat.unfurl bodies and answers with `responses` in order. */
function fakeSlack(responses: Array<{ ok: boolean; error?: string }> = [{ ok: true }]) {
  const bodies: Array<Record<string, unknown>> = [];
  const headers: Headers[] = [];
  let i = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://slack.com/api/chat.unfurl");
    bodies.push(JSON.parse(String(init?.body)));
    headers.push(new Headers(init?.headers));
    const response = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(response), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, bodies, headers };
}

function env(overrides: Partial<SlackEnv> = {}): SlackEnv {
  return {
    WEB_ORIGIN: WEB,
    API_ORIGIN: "https://api.uploads.sh",
    SLACK_TEAM_ID: "T123",
    SLACK_SIGNING_SECRET: SECRET,
    SLACK_BOT_TOKEN: TOKEN,
    ...overrides,
  };
}

async function signedRequest(payload: unknown, options: { secret?: string; ts?: string } = {}) {
  const body = JSON.stringify(payload);
  const ts = options.ts ?? nowTs();
  const signature = await signSlackRequest(options.secret ?? SECRET, ts, body);
  return new Request("https://agents.uploads.sh/slack/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Slack-Request-Timestamp": ts,
      "X-Slack-Signature": signature,
    },
    body,
  });
}

function linkShared(urls: string[], extra: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    team_id: "T123",
    event_id: "Ev1",
    event: {
      type: "link_shared",
      channel: "C123",
      message_ts: "1700000000.000100",
      links: urls.map((url) => ({ domain: new URL(url).hostname, url })),
      ...extra,
    },
  };
}

type Blocks = Array<Record<string, any>>;

/** Runs one link_shared event through the app and returns the blocks sent for `url`. */
async function unfurl(url: string, fixtures: Record<string, unknown>, extra = {}) {
  const api = fakeApi(fixtures);
  const slack = fakeSlack();
  const app = createApp({ slackFetch: slack.fetch });
  const { ctx, settle } = executionCtx();
  const res = await app.fetch(
    await signedRequest(linkShared([url], extra)),
    env({ API: api.fetcher }),
    ctx,
  );
  expect(res.status).toBe(200);
  await settle();
  const unfurls = slack.bodies[0]?.unfurls as Record<string, { blocks: Blocks }> | undefined;
  return { api, slack, blocks: unfurls?.[url]?.blocks };
}

const FILE_PAGE = "https://uploads.sh/f/default/gh/acme/app/pull/12/after.png";
const FILE = {
  workspace: "default",
  key: "gh/acme/app/pull/12/after.png",
  url: "https://storage.uploads.sh/default/gh/acme/app/pull/12/after.png",
  size: 138352,
  contentType: "image/png",
  uploaded: "2026-10-18T00:17:35.847Z",
  metadata: { path: "/settings", "gh.repo": "acme/app" },
  github: {
    repo: "acme/app",
    kind: "pull",
    number: 12,
    url: "https://github.com/acme/app/pull/12",
    title: "Settings <redesign>",
  },
};
const FILE_FIXTURES = { "/public/files/default/gh/acme/app/pull/12/after.png": FILE };

const FEED_ID = "feed_ziLKxuD-uleBj_1teOm5yw";
const FEED_ITEM = {
  id: "item1",
  filename: "after.png",
  status: "available",
  url: "https://storage.uploads.sh/default/gh/acme/app/pull/12/after.png",
  contentType: "image/png",
  size: 1000,
  uploaded: "2026-10-18T00:17:35.847Z",
  path: "/settings",
  state: "after",
};
const FEED_FIXTURES = {
  [`/public/feeds/${FEED_ID}?limit=1`]: {
    id: FEED_ID,
    title: "acme/app#12",
    repo: "acme/app",
    number: 12,
    kind: "pull",
    updatedAt: "2026-10-17T00:00:00.000Z",
    items: [FEED_ITEM],
    github: { title: "Settings redesign", state: "merged" },
  },
  [`/public/feeds/${FEED_ID}/items/item1`]: {
    feed: { id: FEED_ID, title: "acme/app#12", repo: "acme/app", number: 12, kind: "pull" },
    item: FEED_ITEM,
    index: 0,
    total: 7,
  },
};

const GALLERY_ID = "gal_abcdefghijklmnopqrstuv";
const GALLERY_FIXTURES = {
  [`/public/galleries/${GALLERY_ID}`]: {
    id: GALLERY_ID,
    title: "Release shots",
    description: "Everything in v2",
    coverItemId: "b",
    updatedAt: "2026-10-18T00:00:00.000Z",
    items: [
      {
        id: "a",
        filename: "one.png",
        status: "available",
        url: "https://storage.uploads.sh/a.png",
        contentType: "image/png",
        size: 1,
        position: 0,
      },
      {
        id: "b",
        filename: "two.png",
        status: "available",
        url: "https://storage.uploads.sh/b.png",
        contentType: "image/png",
        size: 1,
        position: 1,
        caption: "The new header",
      },
      {
        id: "c",
        filename: "gone.png",
        status: "withheld",
        url: null,
        contentType: null,
        size: null,
        position: 2,
      },
    ],
  },
};

const contextText = (blocks: Blocks) => blocks.at(-1)!.elements.at(-1).text as string;
const sectionText = (blocks: Blocks) => blocks[0]!.text.text as string;

describe("verifySlackSignature", () => {
  it("accepts a body signed with the secret", async () => {
    const ts = nowTs();
    const signature = await signSlackRequest(SECRET, ts, "hello");
    expect(
      await verifySlackSignature({
        signingSecret: SECRET,
        timestamp: ts,
        signature,
        rawBody: "hello",
      }),
    ).toBe(true);
  });

  it("rejects a tampered body, wrong secret, stale timestamp, and malformed header", async () => {
    const ts = nowTs();
    const signature = await signSlackRequest(SECRET, ts, "hello");
    const base = { signingSecret: SECRET, timestamp: ts, signature, rawBody: "hello" };
    expect(await verifySlackSignature({ ...base, rawBody: "hellp" })).toBe(false);
    expect(await verifySlackSignature({ ...base, signingSecret: "other" })).toBe(false);
    expect(await verifySlackSignature({ ...base, nowSeconds: Number(ts) + 60 * 5 + 1 })).toBe(
      false,
    );
    expect(await verifySlackSignature({ ...base, signature: "v1=abc" })).toBe(false);
    expect(await verifySlackSignature({ ...base, signature: "v0=zz" })).toBe(false);
    expect(await verifySlackSignature({ ...base, timestamp: undefined })).toBe(false);
  });
});

describe("POST /slack/events", () => {
  it("answers url_verification with the challenge", async () => {
    const { ctx } = executionCtx();
    const res = await createApp().fetch(
      await signedRequest({ type: "url_verification", challenge: "abc123" }),
      env(),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "abc123" });
  });

  it("rejects badly signed and stale requests", async () => {
    const app = createApp();
    const { ctx } = executionCtx();
    const payload = { type: "url_verification", challenge: "x" };
    expect(
      (await app.fetch(await signedRequest(payload, { secret: "nope" }), env(), ctx)).status,
    ).toBe(401);
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    expect((await app.fetch(await signedRequest(payload, { ts: stale }), env(), ctx)).status).toBe(
      401,
    );
  });

  it("fails closed when the signing secret is unset", async () => {
    const { ctx } = executionCtx();
    const res = await createApp().fetch(
      await signedRequest({ type: "url_verification", challenge: "x" }),
      env({ SLACK_SIGNING_SECRET: "" }),
      ctx,
    );
    expect(res.status).toBe(503);
  });

  it("uses unfurl_id and source when Slack sends them", async () => {
    const { slack } = await unfurl(FILE_PAGE, FILE_FIXTURES, {
      unfurl_id: "U.abc",
      source: "composer",
      channel: "COMPOSER",
    });
    expect(slack.headers[0]!.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(slack.bodies[0]).toMatchObject({ unfurl_id: "U.abc", source: "composer" });
    expect(slack.bodies[0]).not.toHaveProperty("channel");
  });

  it("skips links the public API won't resolve (private, held, missing)", async () => {
    const { api, slack } = await unfurl("https://uploads.sh/f/acme/private.png", {});
    expect(api.calls).toEqual(["/public/files/acme/private.png"]);
    expect(slack.fetch).not.toHaveBeenCalled();
  });

  it("never looks up links on other origins or non-share paths", async () => {
    const api = fakeApi({});
    const slack = fakeSlack();
    const { ctx, settle } = executionCtx();
    await createApp({ slackFetch: slack.fetch }).fetch(
      await signedRequest(
        linkShared(["https://evil.example/f/acme/x.png", "https://uploads.sh/pricing"]),
      ),
      env({ API: api.fetcher }),
      ctx,
    );
    await settle();
    expect(api.calls).toHaveLength(0);
    expect(slack.fetch).not.toHaveBeenCalled();
  });

  it("ignores events from a team other than the pinned one", async () => {
    const api = fakeApi(FILE_FIXTURES);
    const slack = fakeSlack();
    const { ctx, settle } = executionCtx();
    await createApp({ slackFetch: slack.fetch }).fetch(
      await signedRequest(linkShared([FILE_PAGE])),
      env({ API: api.fetcher, SLACK_TEAM_ID: "T999" }),
      ctx,
    );
    await settle();
    expect(api.calls).toHaveLength(0);
    expect(slack.fetch).not.toHaveBeenCalled();
  });

  it("retries without images when Slack can't fetch one", async () => {
    const api = fakeApi(FILE_FIXTURES);
    const slack = fakeSlack([{ ok: false, error: "invalid_blocks" }, { ok: true }]);
    const { ctx, settle } = executionCtx();
    await createApp({ slackFetch: slack.fetch }).fetch(
      await signedRequest(linkShared([FILE_PAGE])),
      env({ API: api.fetcher }),
      ctx,
    );
    await settle();
    expect(slack.bodies).toHaveLength(2);
    const retry = (slack.bodies[1]!.unfurls as Record<string, { blocks: Blocks }>)[FILE_PAGE]!
      .blocks;
    expect(retry.map((b) => b.type)).toEqual(["section", "context"]);
    expect(retry[1]!.elements.map((e: { type: string }) => e.type)).toEqual(["mrkdwn"]);
  });

  it("acks event types it doesn't handle without doing anything", async () => {
    const slack = fakeSlack();
    const { ctx, settle } = executionCtx();
    const res = await createApp({ slackFetch: slack.fetch }).fetch(
      await signedRequest({
        type: "event_callback",
        team_id: "T1",
        event: { type: "app_mention" },
      }),
      env(),
      ctx,
    );
    await settle();
    expect(res.status).toBe(200);
    expect(slack.fetch).not.toHaveBeenCalled();
  });
});

describe("previews", () => {
  it("file: title, linked PR, full image, and facts", async () => {
    const { blocks } = await unfurl(FILE_PAGE, FILE_FIXTURES);
    expect(blocks!.map((b) => b.type)).toEqual(["section", "image", "context"]);
    expect(sectionText(blocks!)).toBe(
      `*<${FILE_PAGE}|after.png>*\n<https://github.com/acme/app/pull/12|acme/app#12> · Settings &lt;redesign&gt;`,
    );
    expect(blocks![1]).toMatchObject({ image_url: FILE.url, alt_text: "after.png" });
    expect(blocks![2]!.elements[0]).toEqual({
      type: "image",
      image_url: "https://uploads.sh/apple-touch-icon.png",
      alt_text: "uploads.sh",
    });
    expect(contextText(blocks!)).toBe(
      "uploads.sh · PNG · 138 kB · /settings · <!date^1792282655^{ago}|2026-10-18>",
    );
  });

  it("file: video shows its poster frame and is labelled", async () => {
    const page = "https://uploads.sh/f/acme/demo.mp4";
    const { blocks } = await unfurl(page, {
      "/public/files/acme/demo.mp4": {
        key: "demo.mp4",
        url: "https://storage.uploads.sh/acme/demo.mp4",
        size: 5_400_000,
        contentType: "video/mp4",
        uploaded: null,
        posterUrl: "https://storage.uploads.sh/acme/demo.poster.jpg",
      },
    });
    expect(sectionText(blocks!)).toBe(`*<${page}|demo.mp4>* · video`);
    expect(blocks![1]).toMatchObject({
      image_url: "https://storage.uploads.sh/acme/demo.poster.jpg",
    });
    expect(contextText(blocks!)).toBe("uploads.sh · MP4 · 5.4 MB");
  });

  it("feed: PR title, repo and state, latest thumbnail, count", async () => {
    const page = `https://uploads.sh/c/${FEED_ID}`;
    const { blocks, api } = await unfurl(page, FEED_FIXTURES);
    expect(api.calls).toEqual([
      `/public/feeds/${FEED_ID}?limit=1`,
      `/public/feeds/${FEED_ID}/items/item1`,
    ]);
    expect(blocks!.map((b) => b.type)).toEqual(["section", "context"]);
    expect(sectionText(blocks!)).toBe(
      `*<${page}|acme/app#12: Settings redesign>*\n<https://github.com/acme/app/pull/12|acme/app> · Merged`,
    );
    expect(blocks![0]!.accessory).toMatchObject({ type: "image", image_url: FEED_ITEM.url });
    expect(contextText(blocks!)).toMatch(
      /^uploads\.sh · 7 files · <!date\^\d+\^\{ago\}\|2026-10-18>$/,
    );
  });

  it("feed item: image, link to its feed, and position", async () => {
    const page = `https://uploads.sh/c/${FEED_ID}/item1`;
    const { blocks } = await unfurl(page, FEED_FIXTURES);
    expect(blocks!.map((b) => b.type)).toEqual(["section", "image", "context"]);
    expect(sectionText(blocks!)).toBe(
      `*<${page}|after.png>*\n<https://uploads.sh/c/${FEED_ID}|acme/app#12> · Change feed`,
    );
    expect(contextText(blocks!)).toMatch(/^uploads\.sh · \/settings · <!date/);
  });

  it("gallery: description, cover thumbnail, and visible item count", async () => {
    const page = `https://uploads.sh/g/${GALLERY_ID}`;
    const { blocks } = await unfurl(page, GALLERY_FIXTURES);
    expect(sectionText(blocks!)).toBe(`*<${page}|Release shots>*\nEverything in v2`);
    expect(blocks![0]!.accessory).toMatchObject({ image_url: "https://storage.uploads.sh/b.png" });
    expect(contextText(blocks!)).toMatch(/^uploads\.sh · 2 items · <!date/);
  });

  it("gallery item: caption as title; withheld items never unfurl", async () => {
    const page = `https://uploads.sh/g/${GALLERY_ID}/b`;
    const { blocks } = await unfurl(page, GALLERY_FIXTURES);
    expect(sectionText(blocks!)).toBe(
      `*<${page}|The new header>*\n<https://uploads.sh/g/${GALLERY_ID}|Release shots>`,
    );
    expect(contextText(blocks!)).toBe("uploads.sh · 2 of 2");

    const withheld = await unfurl(`https://uploads.sh/g/${GALLERY_ID}/c`, GALLERY_FIXTURES);
    expect(withheld.slack.fetch).not.toHaveBeenCalled();
  });

  it("drops images Slack can't render, and escapes mrkdwn", () => {
    const blocks = previewBlocks({
      url: "https://uploads.sh/f/acme/logo.svg",
      title: "<!here> logo",
      image: { url: "https://storage.uploads.sh/acme/logo.svg", alt: "logo", size: "large" },
      facts: [{ text: "SVG" }],
    });
    expect(blocks.map((b) => b.type)).toEqual(["section", "context"]);
    expect(sectionText(blocks)).toContain("&lt;!here&gt; logo");
    expect(escapeMrkdwn("a <b> & c")).toBe("a &lt;b&gt; &amp; c");
  });
});

describe("parseShareUrl", () => {
  it("recognizes share routes on the web origin only", () => {
    expect(parseShareUrl("https://uploads.sh/f/acme/a/b.png", WEB)).toEqual({
      kind: "file",
      workspace: "acme",
      key: "a/b.png",
    });
    expect(parseShareUrl(`https://uploads.sh/feed/${FEED_ID}/x1`, WEB)).toEqual({
      kind: "feed",
      id: FEED_ID,
      itemId: "x1",
    });
    expect(parseShareUrl(`https://uploads.sh/g/${GALLERY_ID}`, WEB)).toEqual({
      kind: "gallery",
      id: GALLERY_ID,
      itemId: undefined,
    });
    expect(parseShareUrl("http://uploads.sh/f/acme/b.png", WEB)).toBeNull();
    expect(parseShareUrl("https://storage.uploads.sh/acme/b.png", WEB)).toBeNull();
    expect(parseShareUrl("https://uploads.sh/f/acme/../secret", WEB)).toBeNull();
    expect(parseShareUrl("https://uploads.sh/g/not-a-gallery", WEB)).toBeNull();
    expect(parseShareUrl("not a url", WEB)).toBeNull();
  });
});

describe("formatBytes", () => {
  it("uses decimal units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(138352)).toBe("138 kB");
    expect(formatBytes(5_400_000)).toBe("5.4 MB");
    expect(formatBytes(null)).toBeNull();
  });
});
