import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { database, SqliteD1 } from "../../api/test/helpers/sqlite-d1";
import type { SlackEnv } from "../src/config";
import {
  entityMetadata,
  PAGE_NEXT_ACTION,
  PAGE_PREV_ACTION,
  PROVIDER_ICON_URL,
  slackRef,
} from "../src/entities";
import { createApp } from "../src/index";
import { saveInstall } from "../src/installs";
import { signSlackRequest } from "../src/slack/signature";

const SECRET = "test-signing-secret";
const TOKENS_KEY = "test-tokens-key-0123456789";
const WEB = "https://uploads.sh";
const ICONS = "https://agents.uploads.sh/slack/icons";

let sqlite: SqliteD1;
beforeEach(async () => {
  sqlite = new SqliteD1("migrations/20261018160000_slack_installations.sql");
  await saveInstall(database(sqlite), TOKENS_KEY, {
    teamId: "T123",
    teamName: "Acme",
    enterpriseId: null,
    appId: "A1",
    botUserId: "UBOT",
    botToken: "xoxb-test",
    scopes: "links:read,links:write",
    installedBySlackUserId: "U1",
  });
});
afterEach(() => sqlite.close());

// --- fixtures (public API responses) ---

const FILE_PAGE = "https://uploads.sh/f/default/gh/acme/app/pull/12/after.png";
const FILE = {
  key: "gh/acme/app/pull/12/after.png",
  url: "https://storage.uploads.sh/default/gh/acme/app/pull/12/after.png",
  size: 138352,
  contentType: "image/png",
  uploaded: "2026-10-18T00:17:35.000Z",
  metadata: { path: "/settings" },
  github: {
    repo: "acme/app",
    kind: "pull",
    number: 12,
    url: "https://github.com/acme/app/pull/12",
    title: "Settings redesign",
  },
};

const FEED_ID = "feed_ziLKxuD-uleBj_1teOm5yw";
const FEED_PAGE = `https://uploads.sh/c/${FEED_ID}`;
function feedItem(id: string, uploaded: string) {
  return {
    id,
    filename: `${id}.png`,
    status: "available",
    url: `https://storage.uploads.sh/${id}.png`,
    contentType: "image/png",
    size: 1000,
    uploaded,
    path: "/settings",
  };
}
const FEED_FEED = { id: FEED_ID, title: "acme/app#12", repo: "acme/app", number: 12, kind: "pull" };
const FIXTURES: Record<string, unknown> = {
  "/public/files/default/gh/acme/app/pull/12/after.png": FILE,
  "/public/files/default/docs/spec.pdf": {
    key: "docs/spec.pdf",
    url: "https://storage.uploads.sh/default/docs/spec.pdf",
    size: 5000,
    contentType: "application/pdf",
    uploaded: "2026-10-18T00:17:35.000Z",
    posterUrl: "https://storage.uploads.sh/default/docs/spec.pdf.poster.webp",
  },
  [`/public/feeds/${FEED_ID}`]: {
    ...FEED_FEED,
    updatedAt: "2026-10-18T00:00:00.000Z",
    items: [
      feedItem("newest", "2026-10-18T00:00:00.000Z"),
      feedItem("middle", "2026-10-17T00:00:00.000Z"),
      {
        ...feedItem("clip", "2026-10-16T00:00:00.000Z"),
        contentType: "video/mp4",
        url: "https://storage.uploads.sh/clip.mp4",
      },
    ],
    github: { title: "Settings redesign", state: "open" },
  },
  [`/public/feeds/${FEED_ID}/items/newest`]: {
    feed: FEED_FEED,
    item: feedItem("newest", "2026-10-18T00:00:00.000Z"),
    prev: null,
    next: "middle",
    index: 0,
    total: 3,
  },
  [`/public/feeds/${FEED_ID}/items/middle`]: {
    feed: FEED_FEED,
    item: feedItem("middle", "2026-10-17T00:00:00.000Z"),
    prev: "newest",
    next: "oldest",
    index: 1,
    total: 3,
  },
};

// --- fakes ---

function fakeApi() {
  return {
    fetch: vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const body = FIXTURES[url.pathname];
      return body === undefined
        ? new Response("{}", { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 });
    }),
  } as unknown as Fetcher;
}

/** Fake slack.com: records each call as { method, body } and answers with `responses` in order. */
function fakeSlack(responses: Array<{ ok: boolean; error?: string }> = [{ ok: true }]) {
  const calls: Array<{ method: string; body: Record<string, any> }> = [];
  let i = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      method: String(input).replace("https://slack.com/api/", ""),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify(responses[Math.min(i++, responses.length - 1)]));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function env(overrides: Partial<SlackEnv> = {}): SlackEnv {
  return {
    WEB_ORIGIN: WEB,
    API_ORIGIN: "https://api.uploads.sh",
    SLACK_SIGNING_SECRET: SECRET,
    SLACK_TOKENS_KEY: TOKENS_KEY,
    SLACK_WORK_OBJECTS: "on",
    DB: database(sqlite),
    API: fakeApi(),
    ...overrides,
  };
}

async function signed(path: string, body: string, contentType: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  return new Request(`https://agents.uploads.sh${path}`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "X-Slack-Request-Timestamp": ts,
      "X-Slack-Signature": await signSlackRequest(SECRET, ts, body),
    },
    body,
  });
}

async function run(request: Request, slack: ReturnType<typeof fakeSlack>, e = env()) {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  const res = await createApp({ slackFetch: slack.fetch }).fetch(request, e, ctx);
  await Promise.all(pending);
  return res;
}

function event(body: Record<string, unknown>) {
  return signed(
    "/slack/events",
    JSON.stringify({ type: "event_callback", team_id: "T123", event: body }),
    "application/json",
  );
}

function linkShared(url: string) {
  return event({
    type: "link_shared",
    channel: "C1",
    message_ts: "1700000000.000100",
    links: [{ domain: "uploads.sh", url }],
  });
}

function blockActions(payload: Record<string, unknown>) {
  const body = new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      team: { id: "T123" },
      user: { id: "U1", team_id: "T123" },
      trigger_id: "trig.2",
      ...payload,
    }),
  }).toString();
  return signed("/slack/interactivity", body, "application/x-www-form-urlencoded");
}

describe("Work Object unfurls", () => {
  it("sends file entity metadata alongside the blocks", async () => {
    const slack = fakeSlack();
    await run(await linkShared(FILE_PAGE), slack);
    expect(slack.calls).toHaveLength(1);
    const body = slack.calls[0]!.body;
    expect(body.unfurls[FILE_PAGE].blocks.length).toBeGreaterThan(0);
    const [entity] = body.metadata.entities;
    expect(entity).toMatchObject({
      app_unfurl_url: FILE_PAGE,
      url: FILE_PAGE,
      entity_type: "slack#/entities/file",
      external_ref: { id: "default/gh/acme/app/pull/12/after!2epng", type: "file" },
    });
    const payload = entity.entity_payload;
    expect(payload.attributes).toEqual({
      title: { text: "after.png" },
      display_type: "Image",
      product_icon: { url: `${ICONS}/type-image.png`, alt_text: "Image" },
      metadata_last_modified: 1792282655,
    });
    expect(payload.fields).toEqual({
      preview: { type: "slack#/types/image", image_url: FILE.url, alt_text: "after.png" },
      date_created: { value: 1792282655 },
    });
    expect(payload.custom_fields).toEqual([
      {
        key: "github",
        label: "GitHub",
        value: "acme/app#12",
        type: "string",
        link: "https://github.com/acme/app/pull/12",
        // A file doesn't know its PR's state, so the icon is the neutral one.
        icon: { url: `${ICONS}/pr.png`, alt_text: "GitHub" },
      },
      { key: "page_path", label: "Page", value: "/settings", type: "string" },
    ]);
    expect(payload.actions.overflow_actions.map((a: { text: string }) => a.text)).toEqual([
      "Open on GitHub",
      "Open original file",
    ]);
  });

  it("labels a PDF as a PDF, with its own header icon", async () => {
    const slack = fakeSlack();
    await run(await linkShared("https://uploads.sh/f/default/docs/spec.pdf"), slack);
    const { attributes } = slack.calls[0]!.body.metadata.entities[0].entity_payload;
    expect(attributes.display_type).toBe("PDF");
    expect(attributes.product_icon).toEqual({ url: `${ICONS}/type-pdf.png`, alt_text: "PDF" });
    // Not on an allowed host by default, so no full-size viewer.
    expect(attributes).not.toHaveProperty("full_size_preview");
    // The card shows the first page the API rendered.
    const { fields } = slack.calls[0]!.body.metadata.entities[0].entity_payload;
    expect(fields.preview.image_url).toBe(
      "https://storage.uploads.sh/default/docs/spec.pdf.poster.webp",
    );
  });

  it("opens a PDF in Slack's full-size viewer on allowed hosts", async () => {
    const slack = fakeSlack();
    await run(
      await linkShared("https://uploads.sh/f/default/docs/spec.pdf"),
      slack,
      env({ SLACK_FULL_SIZE_HOSTS: "storage.uploads.sh" }),
    );
    const { attributes } = slack.calls[0]!.body.metadata.entities[0].entity_payload;
    expect(attributes.full_size_preview).toEqual({
      is_supported: true,
      preview_url: "https://storage.uploads.sh/default/docs/spec.pdf",
      mime_type: "application/pdf",
    });
  });

  it("drops query strings from the canonical url but keeps the posted one", async () => {
    const slack = fakeSlack();
    await run(await linkShared(`${FILE_PAGE}?utm=x`), slack);
    expect(slack.calls[0]!.body.metadata.entities[0]).toMatchObject({
      app_unfurl_url: `${FILE_PAGE}?utm=x`,
      url: FILE_PAGE,
    });
  });

  it("a feed card is its latest image alone", async () => {
    const slack = fakeSlack();
    await run(await linkShared(FEED_PAGE), slack);
    const [entity] = slack.calls[0]!.body.metadata.entities;
    expect(entity.entity_type).toBe("slack#/entities/content_item");
    expect(entity.external_ref).toEqual({ id: FEED_ID, type: "feed" });
    expect(entity.entity_payload.attributes.display_type).toBe("Change feed");
    expect(entity.entity_payload.attributes.product_icon.url).toBe(`${ICONS}/type-collection.png`);
    // Slack draws the cover full width and clips fields under it, so the
    // card sends the image and nothing else; the side panel has the rest.
    expect(entity.entity_payload.fields).toEqual({
      preview: {
        type: "slack#/types/image",
        image_url: "https://storage.uploads.sh/newest.png",
        alt_text: "newest.png",
      },
    });
    expect(entity.entity_payload).not.toHaveProperty("custom_fields");
    // The unfurl has no pager buttons (those live in the flexpane), only the PR link.
    expect(entity.entity_payload.actions).toEqual({
      overflow_actions: [
        {
          text: "Open on GitHub",
          action_id: "uploads_wo_open_0",
          url: "https://github.com/acme/app/pull/12",
        },
      ],
    });
  });

  it("offers Slack's full-size viewer only for images on allowed hosts", async () => {
    const off = fakeSlack();
    await run(await linkShared(FILE_PAGE), off);
    expect(off.calls[0]!.body.metadata.entities[0].entity_payload.attributes).not.toHaveProperty(
      "full_size_preview",
    );

    const on = fakeSlack();
    await run(
      await linkShared(FILE_PAGE),
      on,
      env({ SLACK_FULL_SIZE_HOSTS: "embed.uploads.sh, storage.uploads.sh" }),
    );
    expect(
      on.calls[0]!.body.metadata.entities[0].entity_payload.attributes.full_size_preview,
    ).toEqual({ is_supported: true, preview_url: FILE.url, mime_type: "image/png" });

    const elsewhere = fakeSlack();
    await run(
      await linkShared(FILE_PAGE),
      elsewhere,
      env({ SLACK_FULL_SIZE_HOSTS: "cdn.example" }),
    );
    expect(
      elsewhere.calls[0]!.body.metadata.entities[0].entity_payload.attributes,
    ).not.toHaveProperty("full_size_preview");
  });

  it("retries without images, then with blocks only, when Slack rejects the metadata", async () => {
    const slack = fakeSlack([
      { ok: false, error: "error_processing_metadata" },
      { ok: false, error: "error_processing_metadata" },
      { ok: true },
    ]);
    await run(await linkShared(FILE_PAGE), slack);
    expect(slack.calls).toHaveLength(3);
    const imageless = slack.calls[1]!.body.metadata.entities[0].entity_payload;
    expect(imageless.fields).not.toHaveProperty("preview");
    expect(imageless.fields.date_created).toEqual({ value: 1792282655 });
    expect(imageless.fields).not.toHaveProperty("created_by");
    expect(imageless.attributes).not.toHaveProperty("product_icon");
    expect(imageless.custom_fields[0]).not.toHaveProperty("icon");
    expect(slack.calls[2]!.body.metadata).toBeUndefined();
    expect(slack.calls[2]!.body.unfurls[FILE_PAGE]).toBeDefined();
  });

  it("keeps the imageless Work Object when Slack accepts it", async () => {
    const slack = fakeSlack([{ ok: false, error: "error_processing_metadata" }, { ok: true }]);
    await run(await linkShared(FILE_PAGE), slack);
    expect(slack.calls).toHaveLength(2);
    expect(slack.calls[1]!.body.metadata.entities).toHaveLength(1);
  });

  it("sends blocks only unless SLACK_WORK_OBJECTS is on", async () => {
    const slack = fakeSlack();
    await run(await linkShared(FILE_PAGE), slack, env({ SLACK_WORK_OBJECTS: undefined }));
    expect(slack.calls[0]!.body.metadata).toBeUndefined();
  });
});

describe("Work Object refs", () => {
  it("escapes characters Slack's external_ref.id pattern rejects", () => {
    const pattern = /^[0-9a-zA-Z\-_:!/=]+$/;
    const ids = ["ws/gh/acme/app/pull/12/after.png", "ws/My Shot (1)!.png", "ws/café.png"];
    for (const id of ids) expect(slackRef({ id, type: "file" }).id).toMatch(pattern);
    expect(slackRef({ id: "ws/a b!.png", type: "file" }).id).toBe("ws/a!20b!21!2epng");
    expect(slackRef({ id: "ws/é", type: "file" }).id).toBe("ws/!c3!a9");
    expect(slackRef({ id: "feed_123/item-4", type: "feed_item" })).toEqual({
      id: "feed_123/item-4",
      type: "feed_item",
    });
  });
});

describe("Work Object creator", () => {
  const gallery = {
    url: "https://uploads.sh/g/abc",
    title: "Launch shots",
    entity: {
      type: "content_item",
      ref: { id: "gallery:abc", type: "gallery" },
      displayType: "Gallery",
      canonicalUrl: "https://uploads.sh/g/abc",
      fields: [],
    },
  } as unknown as Parameters<typeof entityMetadata>[0];

  it("leaves the creator off the card", () => {
    expect(entityMetadata(gallery).entity_payload.fields).not.toHaveProperty("created_by");
  });

  it("falls back to uploads.sh when there's no repo owner", () => {
    const { fields } = entityMetadata(gallery, undefined, { details: true })
      .entity_payload as Record<string, any>;
    expect(fields.created_by).toEqual({
      type: "slack#/types/user",
      user: {
        text: "uploads.sh",
        url: "https://uploads.sh",
        icon: { url: PROVIDER_ICON_URL, alt_text: "uploads.sh" },
      },
    });
    const imageless = entityMetadata(gallery, undefined, { images: false, details: true })
      .entity_payload as Record<string, any>;
    expect(imageless.fields.created_by.user).not.toHaveProperty("icon");
  });
});

describe("Work Object flexpane", () => {
  it("presents a file's details", async () => {
    const slack = fakeSlack();
    await run(
      await event({
        type: "entity_details_requested",
        trigger_id: "trig.1",
        app_unfurl_url: FILE_PAGE,
        entity_url: FILE_PAGE,
      }),
      slack,
    );
    expect(slack.calls).toHaveLength(1);
    expect(slack.calls[0]!.method).toBe("entity.presentDetails");
    expect(slack.calls[0]!.body).toMatchObject({
      trigger_id: "trig.1",
      metadata: {
        entity_type: "slack#/entities/file",
        url: FILE_PAGE,
        external_ref: { id: "default/gh/acme/app/pull/12/after!2epng", type: "file" },
      },
    });
    // The side panel names the repo owner as creator, which the card leaves out.
    expect(slack.calls[0]!.body.metadata.entity_payload.fields.created_by.user).toEqual({
      text: "acme",
      url: "https://github.com/acme",
      icon: { url: "https://avatars.githubusercontent.com/acme", alt_text: "acme" },
    });
    // The side panel ends with size and type, which the card leaves out.
    const keys = slack.calls[0]!.body.metadata.entity_payload.custom_fields.map(
      (f: { key: string }) => f.key,
    );
    expect(keys).toEqual(["github", "page_path", "file_size", "content_type"]);
  });

  it("opens a feed at its newest item with only an Older button", async () => {
    const slack = fakeSlack();
    await run(
      await event({
        type: "entity_details_requested",
        trigger_id: "trig.1",
        app_unfurl_url: FEED_PAGE,
      }),
      slack,
    );
    const metadata = slack.calls[0]!.body.metadata;
    expect(metadata.external_ref).toEqual({ id: FEED_ID, type: "feed" });
    const payload = metadata.entity_payload;
    // The PR's state rides on the GitHub field instead of a field of its own.
    expect(payload.custom_fields).toContainEqual({
      key: "github",
      label: "GitHub",
      value: "acme/app#12 · Open",
      type: "string",
      link: "https://github.com/acme/app/pull/12",
      icon: { url: `${ICONS}/pr-open.png`, alt_text: "GitHub" },
    });
    expect(payload.custom_fields.map((f: { key: string }) => f.key)).not.toContain("state");
    expect(payload.fields.preview.image_url).toBe("https://storage.uploads.sh/newest.png");
    expect(payload.custom_fields.slice(0, 2)).toEqual([
      {
        key: "showing",
        label: "Showing",
        value: "newest.png",
        type: "string",
        link: `https://uploads.sh/c/${FEED_ID}/newest`,
      },
      { key: "position", label: "Position", value: "1 of 3, newest first", type: "string" },
    ]);
    expect(payload.actions.primary_actions).toEqual([
      { text: "Older", action_id: PAGE_NEXT_ACTION, value: "middle" },
    ]);
    // Each item links to its own Work Object; a video without a poster gets no icon.
    const list = payload.custom_fields.find((f: { key: string }) => f.key === "items_list");
    expect(list).toMatchObject({ label: "Latest files", item_type: "slack#/types/entity_ref" });
    expect(list.value[0]).toEqual({
      type: "slack#/types/entity_ref",
      entity_ref: {
        entity_url: `https://uploads.sh/c/${FEED_ID}/newest`,
        external_ref: { id: `${FEED_ID}/newest`, type: "feed_item" },
        title: "newest.png",
        display_type: "Image",
        icon: { url: "https://storage.uploads.sh/newest.png", alt_text: "newest.png" },
      },
    });
    expect(list.value[2].entity_ref).not.toHaveProperty("icon");
  });

  it("pages a feed from the flexpane buttons, keeping the feed's identity", async () => {
    const slack = fakeSlack();
    await run(
      await blockActions({
        container: { type: "entity_detail", app_unfurl_url: FEED_PAGE, entity_url: FEED_PAGE },
        actions: [{ action_id: PAGE_NEXT_ACTION, value: "middle" }],
      }),
      slack,
    );
    expect(slack.calls).toHaveLength(1);
    const body = slack.calls[0]!.body;
    expect(body.trigger_id).toBe("trig.2");
    expect(body.metadata.external_ref).toEqual({ id: FEED_ID, type: "feed" });
    expect(body.metadata.entity_payload.fields.preview.image_url).toBe(
      "https://storage.uploads.sh/middle.png",
    );
    expect(body.metadata.entity_payload.actions.primary_actions).toEqual([
      { text: "Newer", action_id: PAGE_PREV_ACTION, value: "newest" },
      { text: "Older", action_id: PAGE_NEXT_ACTION, value: "oldest" },
    ]);
  });

  it("answers not_found for links the public API won't resolve", async () => {
    const slack = fakeSlack();
    await run(
      await event({
        type: "entity_details_requested",
        trigger_id: "trig.1",
        app_unfurl_url: "https://uploads.sh/f/acme/private.png",
      }),
      slack,
    );
    expect(slack.calls[0]!.body).toEqual({ trigger_id: "trig.1", error: { status: "not_found" } });
  });

  it("answers not_found for a pager item that isn't public", async () => {
    const slack = fakeSlack();
    await run(
      await blockActions({
        container: { type: "entity_detail", app_unfurl_url: FEED_PAGE },
        actions: [{ action_id: PAGE_NEXT_ACTION, value: "oldest" }],
      }),
      slack,
    );
    expect(slack.calls[0]!.body.error).toEqual({ status: "not_found" });
  });

  it("ignores pager buttons outside a flexpane and links on other origins", async () => {
    const slack = fakeSlack();
    await run(
      await blockActions({
        container: { type: "message_attachment", app_unfurl_url: FEED_PAGE },
        actions: [{ action_id: PAGE_NEXT_ACTION, value: "middle" }],
      }),
      slack,
    );
    await run(
      await event({
        type: "entity_details_requested",
        trigger_id: "trig.1",
        app_unfurl_url: `https://evil.example/c/${FEED_ID}`,
      }),
      slack,
    );
    expect(slack.calls).toHaveLength(1);
    expect(slack.calls[0]!.body.error).toEqual({ status: "not_found" });
  });
});
