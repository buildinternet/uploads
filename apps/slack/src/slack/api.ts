/**
 * Minimal Slack Web API client: plain fetch, no SDK. Each method this app
 * calls gets a typed wrapper here so features never build Slack requests by
 * hand.
 */

export const SLACK_API_ORIGIN = "https://slack.com/api";

/** Block Kit blocks are passed through as-is; see unfurl.ts for the shapes this app builds. */
export type Block = Record<string, unknown>;

export interface SlackApiResult {
  ok: boolean;
  error?: string;
  /** Slack's detail on an error or warning, e.g. which metadata field it rejected. */
  response_metadata?: { messages?: string[]; warnings?: string[] };
}

export interface SlackApiOptions {
  token: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Write methods take JSON; read methods such as users.info only take form
 * fields, so `form: true` sends the body urlencoded instead.
 */
async function call(
  method: string,
  body: Record<string, unknown>,
  options: SlackApiOptions,
  form = false,
): Promise<SlackApiResult> {
  const doFetch = options.fetch ?? globalThis.fetch;
  try {
    const response = await doFetch(`${SLACK_API_ORIGIN}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.token}`,
        "Content-Type": form
          ? "application/x-www-form-urlencoded"
          : "application/json; charset=utf-8",
      },
      body: form
        ? new URLSearchParams(body as Record<string, string>).toString()
        : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false, error: `http_${response.status}` };
    const json = (await response.json()) as SlackApiResult & Record<string, unknown>;
    return { ...json, ok: json.ok === true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "request_failed" };
  }
}

/** Target for `chat.unfurl`: a posted message, or a message still in the composer. */
export type UnfurlTarget =
  | { channel: string; ts: string }
  | { unfurl_id: string; source: "composer" | "conversations_history" };

/**
 * `chat.unfurl`: https://api.slack.com/methods/chat.unfurl. `metadata`
 * carries Work Object entities (entities.ts); Slack draws those where it
 * can and falls back to the blocks elsewhere.
 */
export function chatUnfurl(
  target: UnfurlTarget,
  unfurls: Record<string, { blocks: Block[] }>,
  options: SlackApiOptions,
  metadata?: { entities: Record<string, unknown>[] },
): Promise<SlackApiResult> {
  return call("chat.unfurl", { ...target, unfurls, ...(metadata ? { metadata } : {}) }, options);
}

/**
 * `entity.presentDetails`: fills a Work Object flexpane for the user whose
 * click produced `trigger_id` (valid for a few seconds). No scope needed.
 * https://docs.slack.dev/reference/methods/entity.presentdetails
 */
export function entityPresentDetails(
  body: {
    trigger_id: string;
    metadata?: Record<string, unknown>;
    error?: { status: string; custom_message?: string };
  },
  options: SlackApiOptions,
): Promise<SlackApiResult> {
  return call("entity.presentDetails", body, options);
}

interface UsersInfoResult extends SlackApiResult {
  user?: { name?: string; real_name?: string; profile?: { display_name?: string } };
}

/**
 * `users.info` (needs `users:read`): the name Slack shows for a user, or
 * null when the call fails (for example, an install from before the scope).
 * https://docs.slack.dev/reference/methods/users.info
 */
export async function slackDisplayName(
  userId: string,
  options: SlackApiOptions,
): Promise<string | null> {
  const result = (await call("users.info", { user: userId }, options, true)) as UsersInfoResult;
  const user = result.ok ? result.user : undefined;
  const name = user?.profile?.display_name || user?.real_name || user?.name;
  return name?.trim() ? name.trim().slice(0, 80) : null;
}

/** `views.publish`: https://docs.slack.dev/reference/methods/views.publish */
export function viewsPublish(
  userId: string,
  view: { type: "home"; blocks: Block[] },
  options: SlackApiOptions,
): Promise<SlackApiResult> {
  return call("views.publish", { user_id: userId, view }, options);
}

interface ConversationsOpenResult extends SlackApiResult {
  channel?: { id?: string };
}

/**
 * Opens (or finds) the app's DM with one user and returns its channel id,
 * or null when the call fails (for example, an install from before
 * `im:write`). https://docs.slack.dev/reference/methods/conversations.open
 */
export async function openDm(userId: string, options: SlackApiOptions): Promise<string | null> {
  const result = (await call(
    "conversations.open",
    { users: userId },
    options,
  )) as ConversationsOpenResult;
  return result.ok ? (result.channel?.id ?? null) : null;
}

/** `chat.postMessage` (needs `chat:write`): https://docs.slack.dev/reference/methods/chat.postMessage */
export function chatPostMessage(
  message: { channel: string; text: string; blocks: Block[] },
  options: SlackApiOptions,
): Promise<SlackApiResult> {
  return call(
    "chat.postMessage",
    { ...message, unfurl_links: false, unfurl_media: false },
    options,
  );
}

/**
 * Replies to a button press through the payload's `response_url`: replaces
 * the message the button sat on, or (`replace: false`) adds a reply only
 * the presser sees and leaves the buttons in place. Only Slack's own hooks
 * host is accepted, so a payload can't point this worker at another server.
 * https://docs.slack.dev/interactivity/handling-user-interaction#message_responses
 */
export async function respondToAction(
  responseUrl: string,
  message: { text: string; blocks: Block[] },
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  replace = true,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(responseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com") return false;
  try {
    const response = await fetchImpl(url.href, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(
        replace
          ? { ...message, replace_original: true }
          : { ...message, replace_original: false, response_type: "ephemeral" },
      ),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
