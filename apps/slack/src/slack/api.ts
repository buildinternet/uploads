/**
 * Minimal Slack Web API client: plain fetch, no SDK. Each method this app
 * calls gets a typed wrapper here so features never build Slack requests by
 * hand. Add `chat.postMessage` here when flag notifications land.
 */

export const SLACK_API_ORIGIN = "https://slack.com/api";

/** Block Kit blocks are passed through as-is; see unfurl.ts for the shapes this app builds. */
export type Block = Record<string, unknown>;

export interface SlackApiResult {
  ok: boolean;
  error?: string;
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

/** `chat.unfurl`: https://api.slack.com/methods/chat.unfurl */
export function chatUnfurl(
  target: UnfurlTarget,
  unfurls: Record<string, { blocks: Block[] }>,
  options: SlackApiOptions,
): Promise<SlackApiResult> {
  return call("chat.unfurl", { ...target, unfurls }, options);
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
