/**
 * `/uploads search <term>`: filename search over the uploads.sh workspaces
 * a Slack workspace is bound to (#1165; `slack_workspace_bindings`, set by a
 * workspace admin under Settings → Slack on uploads.sh).
 *
 * Anyone who is a full member of the Slack workspace can search, linked
 * account or not: the admin opted the whole Slack workspace in. Guests
 * (single- and multi-channel) and people from other organizations can't.
 * Results are the files the public share page would show anyway (uploads-api
 * drops private and held ones), and the reply is ephemeral.
 *
 * Slack wants an answer within 3 seconds and a storage walk can take
 * longer, so the handler acks with "Searching…" and posts the results to
 * the command's `response_url`.
 * https://docs.slack.dev/interactivity/implementing-slash-commands
 */
import { botTokenFor, type SlackEnv } from "./config";
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

interface SearchResponse {
  bound: boolean;
  results: { workspace: string; key: string }[];
  truncated: boolean;
}

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
  const lines = response.results.map((r) => {
    const name = escapeMrkdwn(r.key.split("/").at(-1) || r.key);
    const where = multipleWorkspaces ? `  ·  ${escapeMrkdwn(r.workspace)}` : "";
    return `• <${sharePageUrl(webOrigin, r.workspace, r.key)}|${name}>${where}`;
  });
  const heading = `Files matching ${quoted}${response.truncated ? " (first matches only)" : ""}:`;
  return {
    text: `${heading}\n${lines.join("\n")}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: heading } },
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    ],
  };
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
