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

async function call(
  method: string,
  body: Record<string, unknown>,
  options: SlackApiOptions,
): Promise<SlackApiResult> {
  const doFetch = options.fetch ?? globalThis.fetch;
  try {
    const response = await doFetch(`${SLACK_API_ORIGIN}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false, error: `http_${response.status}` };
    const json = (await response.json()) as SlackApiResult;
    return { ok: json.ok === true, ...(json.error ? { error: json.error } : {}) };
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
