/**
 * Held-upload DMs.
 *
 * When the classifier holds an upload (a likely secret or personal
 * information), uploads-api picks who should hear about it
 * (apps/api/src/slack-hold-notify.ts) and calls `/slack/internal/hold` once
 * per Slack account. This module sends that person a DM from the app with
 * two buttons:
 *
 *   - **Approve** asks uploads-api's internal approve route to release the
 *     file as the uploads.sh account linked to whoever pressed it. The API
 *     re-checks the link and workspace membership, so a forwarded or stale
 *     DM can't approve for someone who isn't a member.
 *   - **Keep held** changes nothing and replaces the buttons with how to
 *     approve later.
 *
 * Either way the DM is rewritten through the button's `response_url`, so
 * the buttons can't be pressed twice.
 */
import { botTokenFor, type SlackEnv } from "./config";
import {
  chatPostMessage,
  openDm,
  respondToAction,
  type Block,
  type SlackApiOptions,
} from "./slack/api";
import { escapeMrkdwn } from "./unfurl";

export const HOLD_APPROVE_ACTION = "uploads_hold_approve";
export const HOLD_KEEP_ACTION = "uploads_hold_keep";

export type HoldReason = "secret" | "pii";

/** What uploads-api sends to `/slack/internal/hold`. */
export interface HoldNotice {
  teamId: string;
  slackUserId: string;
  workspace: string;
  key: string;
  reason: HoldReason;
  pageUrl: string;
  isUploader: boolean;
}

const TEAM_ID = /^[TE][A-Z0-9]{1,20}$/;
const SLACK_USER_ID = /^[UW][A-Z0-9]{1,20}$/;
const WORKSPACE = /^[a-z0-9-]{1,64}$/;

/** Slack caps a button's `value` at 2000 characters. */
const MAX_BUTTON_VALUE = 2000;

const DOCS_URL = "https://uploads.sh/docs/agents#held-uploads";

/** Validates the internal request body; null when anything is off. */
export function parseHoldNotice(input: unknown, webOrigin: string): HoldNotice | null {
  if (!input || typeof input !== "object") return null;
  const v = input as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" ? x : "");
  const notice: HoldNotice = {
    teamId: str(v.teamId),
    slackUserId: str(v.slackUserId),
    workspace: str(v.workspace),
    key: str(v.key),
    reason: v.reason === "pii" ? "pii" : "secret",
    pageUrl: str(v.pageUrl),
    isUploader: v.isUploader === true,
  };
  if (
    !TEAM_ID.test(notice.teamId) ||
    !SLACK_USER_ID.test(notice.slackUserId) ||
    !WORKSPACE.test(notice.workspace) ||
    !notice.key ||
    notice.key.length > 1024 ||
    (v.reason !== "secret" && v.reason !== "pii")
  ) {
    return null;
  }
  // The page link must be on uploads.sh; drop anything else rather than
  // put a foreign URL in a DM.
  try {
    if (new URL(notice.pageUrl).origin !== new URL(webOrigin).origin) notice.pageUrl = "";
  } catch {
    notice.pageUrl = "";
  }
  return notice;
}

function fileName(key: string): string {
  return key.split("/").pop() || key;
}

function reasonText(reason: HoldReason): string {
  return reason === "pii"
    ? "it may show personal information, such as an ID document or financial details"
    : "it may show a secret, such as an API key, password, or token";
}

/** Button `value`: which file. Whoever presses it is read from the payload. */
export function holdButtonValue(workspace: string, key: string): string {
  return JSON.stringify({ w: workspace, k: key });
}

function parseButtonValue(value: string | undefined): { workspace: string; key: string } | null {
  try {
    const parsed = JSON.parse(value ?? "") as { w?: unknown; k?: unknown };
    if (typeof parsed.w !== "string" || typeof parsed.k !== "string") return null;
    if (!WORKSPACE.test(parsed.w) || !parsed.k) return null;
    return { workspace: parsed.w, key: parsed.k };
  } catch {
    return null;
  }
}

function fileLine(workspace: string, key: string, pageUrl: string): string {
  const name = escapeMrkdwn(fileName(key));
  const linked = pageUrl ? `<${pageUrl}|${name}>` : name;
  return `*${linked}* in *${escapeMrkdwn(workspace)}*`;
}

function approveLater(key: string): string {
  return `Approve it later with \`uploads approve ${escapeMrkdwn(key)}\`.`;
}

/** The DM for a new hold. */
export function holdMessage(notice: HoldNotice): { text: string; blocks: Block[] } {
  const lead = notice.isUploader
    ? "Your upload is held for review"
    : `An upload in ${notice.workspace} is held for review`;
  const value = holdButtonValue(notice.workspace, notice.key);
  const blocks: Block[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🔒 *${escapeMrkdwn(lead)}*\n${fileLine(notice.workspace, notice.key, notice.pageUrl)}\nHeld because ${reasonText(notice.reason)}.`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `While it's held, its public link returns 404 and pull request comments leave it out. Check the file before you approve it. If it does show a credential, rotate the credential. <${DOCS_URL}|About held uploads>`,
        },
      ],
    },
  ];
  if (value.length <= MAX_BUTTON_VALUE) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: HOLD_APPROVE_ACTION,
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
          value,
          confirm: {
            title: { type: "plain_text", text: "Approve this upload?" },
            text: {
              type: "plain_text",
              text: "It goes back to its public link, and pull request comments show it again.",
            },
            confirm: { type: "plain_text", text: "Approve" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
        {
          type: "button",
          action_id: HOLD_KEEP_ACTION,
          text: { type: "plain_text", text: "Keep held" },
          value,
        },
      ],
    });
  } else {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: approveLater(notice.key) }],
    });
  }
  return { text: `${lead}: ${fileName(notice.key)}`, blocks };
}

export interface HoldContext {
  env: SlackEnv;
  slackFetch?: typeof globalThis.fetch;
}

/** Sends one hold DM. Returns false when the app can't reach the user. */
export async function sendHoldNotice(notice: HoldNotice, ctx: HoldContext): Promise<boolean> {
  const token = await botTokenFor(ctx.env, notice.teamId);
  if (!token) return false;
  const options: SlackApiOptions = { token, fetch: ctx.slackFetch };
  const channel = await openDm(notice.slackUserId, options);
  if (!channel) {
    console.error("slack.holds: conversations.open failed", { team: notice.teamId });
    return false;
  }
  const result = await chatPostMessage({ channel, ...holdMessage(notice) }, options);
  if (!result.ok) {
    console.error("slack.holds: chat.postMessage failed", { error: result.error });
  }
  return result.ok;
}

type ApproveOutcome = "approved" | "not_held" | "not_allowed" | "failed";

/** Asks uploads-api to approve as the Slack user who pressed the button. */
async function approveViaApi(
  env: SlackEnv,
  input: { teamId: string; slackUserId: string; workspace: string; key: string },
): Promise<ApproveOutcome> {
  // Only the service binding reaches the internal route (host api.internal);
  // without it (local dev) there is no way to approve from Slack.
  if (!env.API) return "failed";
  try {
    const res = await env.API.fetch("https://api.internal/internal/slack/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (res.status === 404) return "not_allowed";
    if (!res.ok) return "failed";
    const body = (await res.json().catch(() => null)) as { approved?: unknown } | null;
    return body?.approved === true ? "approved" : "not_held";
  } catch {
    return "failed";
  }
}

function resolvedMessage(
  workspace: string,
  key: string,
  line: string,
): { text: string; blocks: Block[] } {
  return {
    text: line.replace(/[*`]/g, ""),
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `${fileLine(workspace, key, "")}\n${line}` },
      },
    ],
  };
}

export interface HoldActionInput {
  actionId: string;
  value?: string;
  teamId: string;
  slackUserId: string;
  responseUrl?: string;
}

/** Handles Approve or Keep held. Never throws. */
export async function handleHoldAction(input: HoldActionInput, ctx: HoldContext): Promise<void> {
  const target = parseButtonValue(input.value);
  if (!target || !input.responseUrl) return;
  const { workspace, key } = target;
  let line: string;
  if (input.actionId === HOLD_KEEP_ACTION) {
    line = `🔒 Kept held. ${approveLater(key)}`;
  } else {
    const outcome = await approveViaApi(ctx.env, {
      teamId: input.teamId,
      slackUserId: input.slackUserId,
      workspace,
      key,
    });
    console.log("slack.holds: approve", { outcome });
    line = {
      approved: "✅ Approved by you. The file is back at its link.",
      not_held: "This file isn't held any more. Someone already approved it, or it was removed.",
      not_allowed:
        "Couldn't approve: connect this Slack account to an uploads.sh account that's a member of the workspace, from the app's Home tab.",
      failed: `Couldn't approve right now. ${approveLater(key)}`,
    }[outcome];
    if (outcome === "failed" || outcome === "not_allowed") {
      // Answer only the presser and keep the buttons, so they can try again.
      const ok = await respondToAction(
        input.responseUrl,
        { text: line, blocks: [{ type: "section", text: { type: "mrkdwn", text: line } }] },
        ctx.slackFetch,
        false,
      );
      if (!ok) console.error("slack.holds: response_url failed");
      return;
    }
  }
  const ok = await respondToAction(
    input.responseUrl,
    resolvedMessage(workspace, key, line),
    ctx.slackFetch,
  );
  if (!ok) console.error("slack.holds: response_url failed");
}
