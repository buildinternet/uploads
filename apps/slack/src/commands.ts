/**
 * `/uploads search <term>`: filename search over the uploads.sh workspaces
 * a Slack workspace is bound to (#1165; `slack_workspace_bindings`, set by a
 * workspace admin under Settings → Slack on uploads.sh).
 *
 * Anyone who is a full member of the Slack workspace can search, linked
 * account or not: the admin opted the whole Slack workspace in. Guests
 * (single- and multi-channel) and people from other organizations can't.
 * Results are the newest few files the public share page would show anyway
 * (uploads-api drops private and held ones), each with a thumbnail when it's
 * an image. The reply is ephemeral; the **Share a file** menu under it posts
 * one to the channel for everyone, as the card its link unfurls to.
 *
 * Slack wants an answer within 3 seconds and a storage walk can take
 * longer, so the handler acks with "Searching…" and posts the results to
 * the command's `response_url`.
 * https://docs.slack.dev/interactivity/implementing-slash-commands
 */
import { botTokenFor, type SlackEnv } from "./config";
import { isSlackImage } from "./entities";
import { shareDeps } from "./events";
import { resolvePreview } from "./share";
import { previewBlocks } from "./unfurl";
import { respondToAction, SLACK_API_ORIGIN, type Block } from "./slack/api";

/** Same cap as uploads-api's `SEARCH_NAME_MAX`. */
const TERM_MAX = 128;

export interface SlashCommand {
  teamId: string;
  userId: string;
  text: string;
  responseUrl: string;
}

export function parseSlashCommand(body: string): SlashCommand | null {
  const form = new URLSearchParams(body);
  const teamId = form.get("team_id") ?? "";
  const userId = form.get("user_id") ?? "";
  const responseUrl = form.get("response_url") ?? "";
  if (!/^[TE][A-Z0-9]{1,20}$/.test(teamId) || !/^[UW][A-Z0-9]{1,20}$/.test(userId)) return null;
  return { teamId, userId, text: (form.get("text") ?? "").trim(), responseUrl };
}

/** The search term in `search <term>`, or null when the text isn't a search. */
export function searchTerm(text: string): string | null {
  const match = /^search\s+(.+)$/is.exec(text.trim());
  const term = match?.[1]?.trim();
  return term ? term.slice(0, TERM_MAX) : null;
}

export const USAGE_TEXT = "Try `/uploads search <filename>`, for example `/uploads search login`.";

interface SlackUser {
  team_id?: string;
  is_bot?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  deleted?: boolean;
}

/** Whether the person is a full member of `teamId`: not a guest, bot, or someone from another org. */
async function isFullMember(
  teamId: string,
  userId: string,
  token: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${SLACK_API_ORIGIN}/users.info`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ user: userId }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await response.json()) as { ok?: boolean; user?: SlackUser };
    const user = json.ok ? json.user : undefined;
    return Boolean(
      user &&
      user.team_id === teamId &&
      !user.is_bot &&
      !user.deleted &&
      !user.is_restricted &&
      !user.is_ultra_restricted,
    );
  } catch {
    return false;
  }
}

interface SearchResult {
  workspace: string;
  key: string;
  imageUrl?: string;
  uploaded?: number;
}

interface SearchResponse {
  bound: boolean;
  results: SearchResult[];
  truncated: boolean;
}

export const SHARE_ACTION = "uploads_search_share";

async function searchViaApi(env: SlackEnv, teamId: string, term: string) {
  // Only the service binding reaches the internal route (host api.internal).
  if (!env.API) return null;
  try {
    const res = await env.API.fetch("https://api.internal/internal/slack/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamId, term }),
    });
    if (!res.ok) return null;
    return (await res.json()) as SearchResponse;
  } catch {
    return null;
  }
}

function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function sharePageUrl(webOrigin: string, workspace: string, key: string): string {
  const path = key.split("/").map(encodeURIComponent).join("/");
  return `${webOrigin.replace(/\/+$/, "")}/f/${encodeURIComponent(workspace)}/${path}`;
}

/** The ephemeral reply for a finished search. */
export function resultsMessage(
  term: string,
  response: SearchResponse,
  webOrigin: string,
): { text: string; blocks: Block[] } {
  const quoted = `“${escapeMrkdwn(term)}”`;
  if (!response.bound) {
    const text =
      "Search isn't on for this Slack workspace yet. A workspace admin on uploads.sh can turn it on under Settings → Slack.";
    return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
  }
  if (response.results.length === 0) {
    const text = `No public files match ${quoted}.`;
    return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
  }
  const multipleWorkspaces = new Set(response.results.map((r) => r.workspace)).size > 1;
  const count = response.results.length;
  const heading = `*${count === 1 ? "Newest file" : `${count} newest files`} matching ${quoted}*${response.truncated ? " (from the first matches)" : ""}`;
  const blocks: Block[] = [{ type: "section", text: { type: "mrkdwn", text: heading } }];
  const lines: string[] = [];
  const shareOptions: Block[] = [];
  for (const r of response.results) {
    const url = sharePageUrl(webOrigin, r.workspace, r.key);
    const name = r.key.split("/").at(-1) || r.key;
    const details = [
      folderLabel(r.key),
      multipleWorkspaces ? escapeMrkdwn(r.workspace) : null,
      r.uploaded ? slackDate(r.uploaded) : null,
    ].filter(Boolean);
    const image = r.imageUrl && isSlackImage(r.imageUrl) ? r.imageUrl : null;
    lines.push(`• <${url}|${escapeMrkdwn(name)}>`);
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `<${url}|*${escapeMrkdwn(name)}*>${details.length ? `\n${details.join(" · ")}` : ""}`,
      },
      ...(image ? { accessory: { type: "image", image_url: image, alt_text: name } } : {}),
    });
    // An option's value holds at most 150 characters; a longer path can't be offered.
    const value = `${r.workspace}/${r.key}`;
    if (value.length <= OPTION_VALUE_MAX) {
      shareOptions.push({
        text: { type: "plain_text", text: clamp(name, OPTION_TEXT_MAX) },
        value,
      });
    }
  }
  if (shareOptions.length > 0) {
    blocks.push(
      { type: "divider" },
      {
        type: "actions",
        elements: [
          {
            type: "static_select",
            action_id: SHARE_ACTION,
            placeholder: { type: "plain_text", text: "Share a file to the channel…" },
            options: shareOptions,
          },
        ],
      },
    );
  }
  return { text: `${heading}\n${lines.join("\n")}`, blocks };
}

const OPTION_VALUE_MAX = 150;
const OPTION_TEXT_MAX = 75;

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The last two folders of a key (`screenshots/sunny/pr-1` → `sunny/pr-1`), or null at the root. */
function folderLabel(key: string): string | null {
  const folders = key.split("/").slice(0, -1);
  return folders.length ? escapeMrkdwn(folders.slice(-2).join("/")) : null;
}

/** Slack renders this in the reader's own timezone. */
function slackDate(ms: number): string {
  const fallback = new Date(ms).toISOString().slice(0, 10);
  return `<!date^${Math.floor(ms / 1000)}^{date_short_pretty}|${fallback}>`;
}

/**
 * A pick from the **Share a file** menu: posts the file to the channel
 * through the results message's `response_url`, as the same card its link
 * unfurls to. The preview comes from the public API, so a file that went
 * private or was held since the search isn't shared.
 */
export async function shareSearchResult(
  action: { value?: string; slackUserId: string; responseUrl?: string },
  deps: { env: SlackEnv; slackFetch?: typeof globalThis.fetch },
): Promise<void> {
  const value = action.value ?? "";
  const slash = value.indexOf("/");
  if (!action.responseUrl || slash < 1 || value.length > OPTION_VALUE_MAX) return;
  const workspace = value.slice(0, slash);
  const key = value.slice(slash + 1);
  if (!/^[a-z0-9-]{1,64}$/.test(workspace) || !key) return;
  const share = shareDeps(deps.env);
  const url = sharePageUrl(share.webOrigin, workspace, key);
  const preview = await resolvePreview(url, share);
  const fetchImpl = deps.slackFetch ?? globalThis.fetch;
  if (!preview) {
    await respondToAction(
      action.responseUrl,
      plainMessage("That file isn't public anymore, so it wasn't shared."),
      fetchImpl,
      false,
    );
    return;
  }
  const name = key.split("/").at(-1) || key;
  await respondToAction(
    action.responseUrl,
    {
      text: `<@${action.slackUserId}> shared <${url}|${escapeMrkdwn(name)}>`,
      blocks: [
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `<@${action.slackUserId}> shared` }],
        },
        ...previewBlocks(preview),
      ],
    },
    fetchImpl,
    "in_channel",
  );
}

function plainMessage(text: string): { text: string; blocks: Block[] } {
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}

const reply = (text: string) => ({ response_type: "ephemeral" as const, text });

/**
 * Handles one signed slash command. Returns the immediate (ephemeral) reply
 * and, for a search, the work that posts the results afterwards.
 */
export function handleSlashCommand(
  command: SlashCommand,
  deps: { env: SlackEnv; slackFetch?: typeof globalThis.fetch },
): { ack: { response_type: "ephemeral"; text: string }; work?: Promise<void> } {
  const term = searchTerm(command.text);
  if (!term) return { ack: reply(USAGE_TEXT) };
  const fetchImpl = deps.slackFetch ?? globalThis.fetch;
  const send = (message: { text: string; blocks: Block[] }) =>
    respondToAction(command.responseUrl, message, fetchImpl, false).then(() => undefined);
  const plain = (text: string) => ({
    text,
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
  });

  const work = (async () => {
    const token = await botTokenFor(deps.env, command.teamId);
    if (!token) {
      await send(plain("uploads.sh isn't installed in this Slack workspace anymore."));
      return;
    }
    if (!(await isFullMember(command.teamId, command.userId, token, fetchImpl))) {
      await send(plain("Search is only available to full members of this Slack workspace."));
      return;
    }
    const response = await searchViaApi(deps.env, command.teamId, term);
    if (!response) {
      await send(plain("Search didn't work just now. Try again in a minute."));
      return;
    }
    await send(resultsMessage(term, response, deps.env.WEB_ORIGIN || "https://uploads.sh"));
  })();
  return { ack: reply(`Searching for “${escapeMrkdwn(term)}”…`), work };
}
