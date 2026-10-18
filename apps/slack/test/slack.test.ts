import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/index";
import type { SlackEnv } from "../src/config";
import { signSlackRequest, verifySlackSignature } from "../src/slack/signature";
import { escapeMrkdwn, isUnfurlableUrl, unfurlBlocks } from "../src/unfurl";

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

type OEmbedFixtures = Record<string, { status: number; body?: unknown }>;

/** Fake uploads-web: answers /oembed?url=… from fixtures keyed by page URL. */
function fakeWeb(fixtures: OEmbedFixtures) {
  const calls: string[] = [];
  const fetcher = {
    fetch: vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      calls.push(url.href);
      const page = url.searchParams.get("url") ?? "";
      const hit = fixtures[page] ?? { status: 404, body: { error: "not_found" } };
      return new Response(JSON.stringify(hit.body ?? {}), {
        status: hit.status,
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
    SLACK_TEAM_ID: "",
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

const PHOTO_PAGE = "https://uploads.sh/f/acme/screenshots/after.png";
const PHOTO = {
  status: 200,
  body: {
    version: "1.0",
    type: "photo",
    title: "after.png",
    url: "https://storage.uploads.sh/acme/screenshots/after.png",
    width: 1200,
    height: 1200,
  },
};

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
    const app = createApp();
    const { ctx } = executionCtx();
    const res = await app.fetch(
      await signedRequest({ type: "url_verification", challenge: "abc123" }),
      env(),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "abc123" });
  });

  it("rejects an unsigned or badly signed request", async () => {
    const app = createApp();
    const { ctx } = executionCtx();
    const bad = await app.fetch(
      await signedRequest({ type: "url_verification", challenge: "x" }, { secret: "nope" }),
      env(),
      ctx,
    );
    expect(bad.status).toBe(401);

    const stale = await app.fetch(
      await signedRequest(
        { type: "url_verification", challenge: "x" },
        { ts: String(Math.floor(Date.now() / 1000) - 3600) },
      ),
      env(),
      ctx,
    );
    expect(stale.status).toBe(401);
  });

  it("fails closed when the signing secret is unset", async () => {
    const app = createApp();
    const { ctx } = executionCtx();
    const res = await app.fetch(
      await signedRequest({ type: "url_verification", challenge: "x" }),
      env({ SLACK_SIGNING_SECRET: "" }),
      ctx,
    );
    expect(res.status).toBe(503);
  });

  it("unfurls a public image link with chat.unfurl", async () => {
    const web = fakeWeb({ [PHOTO_PAGE]: PHOTO });
    const slack = fakeSlack();
    const app = createApp({ slackFetch: slack.fetch });
    const { ctx, settle } = executionCtx();

    const res = await app.fetch(
      await signedRequest(linkShared([PHOTO_PAGE])),
      env({ WEB: web.fetcher }),
      ctx,
    );
    expect(res.status).toBe(200);
    await settle();

    expect(web.calls).toHaveLength(1);
    const lookup = new URL(web.calls[0]!);
    expect(lookup.origin + lookup.pathname).toBe("https://uploads.sh/oembed");
    expect(lookup.searchParams.get("url")).toBe(PHOTO_PAGE);

    expect(slack.bodies).toHaveLength(1);
    expect(slack.headers[0]!.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    const body = slack.bodies[0]!;
    expect(body.channel).toBe("C123");
    expect(body.ts).toBe("1700000000.000100");
    const blocks = (body.unfurls as Record<string, { blocks: Array<Record<string, unknown>> }>)[
      PHOTO_PAGE
    ]!.blocks;
    expect(blocks.map((b) => b.type)).toEqual(["section", "image", "context"]);
    expect(blocks[1]).toMatchObject({
      image_url: "https://storage.uploads.sh/acme/screenshots/after.png",
      alt_text: "after.png",
    });
  });

  it("uses unfurl_id and source when Slack sends them", async () => {
    const web = fakeWeb({ [PHOTO_PAGE]: PHOTO });
    const slack = fakeSlack();
    const app = createApp({ slackFetch: slack.fetch });
    const { ctx, settle } = executionCtx();
    await app.fetch(
      await signedRequest(
        linkShared([PHOTO_PAGE], { unfurl_id: "U.abc", source: "composer", channel: "COMPOSER" }),
      ),
      env({ WEB: web.fetcher }),
      ctx,
    );
    await settle();
    expect(slack.bodies[0]).toMatchObject({ unfurl_id: "U.abc", source: "composer" });
    expect(slack.bodies[0]).not.toHaveProperty("channel");
  });

  it("skips links the oEmbed endpoint won't resolve (private, held, missing)", async () => {
    const web = fakeWeb({});
    const slack = fakeSlack();
    const app = createApp({ slackFetch: slack.fetch });
    const { ctx, settle } = executionCtx();
    await app.fetch(
      await signedRequest(linkShared(["https://uploads.sh/f/acme/private.png"])),
      env({ WEB: web.fetcher }),
      ctx,
    );
    await settle();
    expect(web.calls).toHaveLength(1);
    expect(slack.fetch).not.toHaveBeenCalled();
  });

  it("never looks up links on other origins", async () => {
    const web = fakeWeb({});
    const slack = fakeSlack();
    const app = createApp({ slackFetch: slack.fetch });
    const { ctx, settle } = executionCtx();
    await app.fetch(
      await signedRequest(linkShared(["https://evil.example/f/acme/x.png"])),
      env({ WEB: web.fetcher }),
      ctx,
    );
    await settle();
    expect(web.calls).toHaveLength(0);
    expect(slack.fetch).not.toHaveBeenCalled();
  });

  it("ignores events from a team other than the pinned one", async () => {
    const web = fakeWeb({ [PHOTO_PAGE]: PHOTO });
    const slack = fakeSlack();
    const app = createApp({ slackFetch: slack.fetch });
    const { ctx, settle } = executionCtx();
    await app.fetch(
      await signedRequest(linkShared([PHOTO_PAGE])),
      env({ WEB: web.fetcher, SLACK_TEAM_ID: "T999" }),
      ctx,
    );
    await settle();
    expect(web.calls).toHaveLength(0);
    expect(slack.fetch).not.toHaveBeenCalled();
  });

  it("retries as text-only previews when Slack can't fetch an image", async () => {
    const web = fakeWeb({ [PHOTO_PAGE]: PHOTO });
    const slack = fakeSlack([{ ok: false, error: "invalid_blocks" }, { ok: true }]);
    const app = createApp({ slackFetch: slack.fetch });
    const { ctx, settle } = executionCtx();
    await app.fetch(await signedRequest(linkShared([PHOTO_PAGE])), env({ WEB: web.fetcher }), ctx);
    await settle();
    expect(slack.bodies).toHaveLength(2);
    const retry = (slack.bodies[1]!.unfurls as Record<string, { blocks: Array<{ type: string }> }>)[
      PHOTO_PAGE
    ]!.blocks;
    expect(retry.map((b) => b.type)).toEqual(["section", "context"]);
  });

  it("acks event types it doesn't handle without doing anything", async () => {
    const slack = fakeSlack();
    const app = createApp({ slackFetch: slack.fetch });
    const { ctx, settle } = executionCtx();
    const res = await app.fetch(
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

describe("unfurlBlocks", () => {
  it("shows a video's poster frame and labels it", () => {
    const blocks = unfurlBlocks("https://uploads.sh/f/acme/demo.mp4", {
      type: "video",
      title: "demo.mp4",
      thumbnail_url: "https://uploads.sh/cdn-cgi/image/width=1200/poster.jpg",
    });
    expect(blocks.map((b) => b.type)).toEqual(["section", "image", "context"]);
    expect((blocks[0]!.text as { text: string }).text).toContain("· video");
  });

  it("renders a link with a thumbnail accessory, and drops SVG images", () => {
    const gallery = unfurlBlocks("https://uploads.sh/g/gal_x", {
      type: "link",
      title: "Release shots",
      thumbnail_url: "https://storage.uploads.sh/a/cover.png",
    });
    expect(gallery.map((b) => b.type)).toEqual(["section", "context"]);
    expect(gallery[0]!.accessory).toMatchObject({ type: "image" });

    const svg = unfurlBlocks("https://uploads.sh/f/acme/logo.svg", {
      type: "photo",
      title: "logo.svg",
      url: "https://storage.uploads.sh/acme/logo.svg",
    });
    expect(svg.map((b) => b.type)).toEqual(["section", "context"]);
  });

  it("escapes mrkdwn control characters in titles", () => {
    expect(escapeMrkdwn("a <b> & c")).toBe("a &lt;b&gt; &amp; c");
    const blocks = unfurlBlocks("https://uploads.sh/f/acme/x.png", {
      type: "link",
      title: "<!here>",
    });
    expect((blocks[0]!.text as { text: string }).text).toContain("&lt;!here&gt;");
  });
});

describe("isUnfurlableUrl", () => {
  it("matches only the configured web origin", () => {
    expect(isUnfurlableUrl("https://uploads.sh/f/a/b.png", WEB)).toBe(true);
    expect(isUnfurlableUrl("http://uploads.sh/f/a/b.png", WEB)).toBe(false);
    expect(isUnfurlableUrl("https://storage.uploads.sh/a/b.png", WEB)).toBe(false);
    expect(isUnfurlableUrl("not a url", WEB)).toBe(false);
  });
});
