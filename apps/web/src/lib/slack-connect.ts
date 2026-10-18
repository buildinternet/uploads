/**
 * Browser wrappers for apps/api's `/me/slack/connect/:ticket` routes, used by
 * `pages/slack/connect.astro`. Same conventions as `api-client.ts`:
 * `credentials: "include"` so the session cookie rides along, and an outage
 * is reported as `unavailable` rather than as an expired link.
 */
import { fetchWithTimeout, type FetchWithTimeoutOptions } from "./request";

export interface SlackTicketPreview {
  teamId: string;
  teamName: string | null;
  slackUserId: string;
  /** Slack display name at mint time; null when Slack didn't provide one. */
  slackUserName: string | null;
}

export type SlackTicketResult =
  | { kind: "ok"; ticket: SlackTicketPreview }
  | { kind: "expired" }
  | { kind: "signed_out" }
  | { kind: "unavailable" };

/** Same shape gate the API applies; anything else can't be a live ticket. */
export function isSlackTicketShape(ticket: string): boolean {
  return /^[A-Za-z0-9_-]{16,64}$/.test(ticket);
}

function parsePreview(body: unknown): SlackTicketPreview | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.teamId !== "string" || typeof b.slackUserId !== "string") return null;
  return {
    teamId: b.teamId,
    slackUserId: b.slackUserId,
    teamName: typeof b.teamName === "string" && b.teamName ? b.teamName : null,
    slackUserName: typeof b.slackUserName === "string" && b.slackUserName ? b.slackUserName : null,
  };
}

async function call(
  apiOrigin: string,
  ticket: string,
  method: "GET" | "POST",
  opts?: FetchWithTimeoutOptions,
): Promise<SlackTicketResult> {
  if (!isSlackTicketShape(ticket)) return { kind: "expired" };
  const result = await fetchWithTimeout(
    `${apiOrigin.replace(/\/$/, "")}/me/slack/connect/${encodeURIComponent(ticket)}`,
    { method, credentials: "include", cache: "no-store" },
    opts,
  );
  if (result.kind === "unavailable") return { kind: "unavailable" };
  const { response } = result;
  if (response.status === 404) return { kind: "expired" };
  if (response.status === 401) return { kind: "signed_out" };
  if (!response.ok) return { kind: "unavailable" };
  const preview = parsePreview(await response.json().catch(() => null));
  return preview ? { kind: "ok", ticket: preview } : { kind: "unavailable" };
}

/** Who the ticket is for. Read-only; the ticket stays usable. */
export function previewSlackTicket(
  apiOrigin: string,
  ticket: string,
  opts?: FetchWithTimeoutOptions,
): Promise<SlackTicketResult> {
  return call(apiOrigin, ticket, "GET", opts);
}

/** Consumes the ticket and links the Slack user to the signed-in account. */
export function connectSlackTicket(
  apiOrigin: string,
  ticket: string,
  opts?: FetchWithTimeoutOptions,
): Promise<SlackTicketResult> {
  return call(apiOrigin, ticket, "POST", opts);
}

/** One Slack account linked to the signed-in uploads.sh account. */
export interface SlackLink {
  teamId: string;
  /** The Slack workspace's name, when the app's install recorded one. */
  teamName: string | null;
  slackUserId: string;
  linkedAt: string;
  /** Scopes the Slack workspace hasn't approved yet; empty when up to date. */
  missingScopes: string[];
}

function parseLinks(body: unknown): SlackLink[] | null {
  const raw = (body as { links?: unknown } | null)?.links;
  if (!Array.isArray(raw)) return null;
  const out: SlackLink[] = [];
  for (const item of raw) {
    const r = item as Record<string, unknown> | null;
    if (
      !r ||
      typeof r.teamId !== "string" ||
      typeof r.slackUserId !== "string" ||
      typeof r.linkedAt !== "string"
    ) {
      return null;
    }
    out.push({
      teamId: r.teamId,
      teamName: typeof r.teamName === "string" && r.teamName ? r.teamName : null,
      slackUserId: r.slackUserId,
      linkedAt: r.linkedAt,
      missingScopes: Array.isArray(r.missingScopes)
        ? r.missingScopes.filter((x): x is string => typeof x === "string")
        : [],
    });
  }
  return out;
}

/** The signed-in user's Slack links, or null when the request fails. */
export async function listSlackLinks(
  apiOrigin: string,
  opts?: FetchWithTimeoutOptions,
): Promise<SlackLink[] | null> {
  const result = await fetchWithTimeout(
    `${apiOrigin.replace(/\/$/, "")}/me/slack/links`,
    { credentials: "include", cache: "no-store" },
    opts,
  );
  if (result.kind === "unavailable" || !result.response.ok) return null;
  return parseLinks(await result.response.json().catch(() => null));
}

/** Removes one Slack link. True when it's gone (including already gone). */
export async function unlinkSlack(
  apiOrigin: string,
  link: Pick<SlackLink, "teamId" | "slackUserId">,
  opts?: FetchWithTimeoutOptions,
): Promise<boolean> {
  const result = await fetchWithTimeout(
    `${apiOrigin.replace(/\/$/, "")}/me/slack/links/${encodeURIComponent(link.teamId)}/${encodeURIComponent(link.slackUserId)}`,
    { method: "DELETE", credentials: "include", cache: "no-store" },
    opts,
  );
  if (result.kind === "unavailable") return false;
  return result.response.ok || result.response.status === 404;
}
