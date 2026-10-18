/**
 * Slack user ↔ uploads.sh account links, in the shared D1 tables
 * `slack_link_tickets` and `slack_user_links`
 * (migration: apps/api/migrations/20261018170000_slack_user_links.sql).
 *
 * This worker only mints tickets, reads links, and removes them. Creating
 * a link needs the uploads.sh session, so it happens in uploads-api
 * (`POST /me/slack/connect/:ticket`) after the user follows the Home tab's
 * Connect button to uploads.sh/slack/connect.
 */
import { randomToken } from "./crypto";

/** How long a Connect button stays usable after the Home tab renders it. */
export const TICKET_TTL_MS = 30 * 60 * 1000;

export interface SlackUserLink {
  userEmail: string | null;
  linkedAt: string;
}

/** base64url(SHA-256(ticket)); the only form a ticket is stored in. */
export async function ticketHash(ticket: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ticket)),
  );
  let s = "";
  for (const byte of digest) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mints a single-use ticket for this Slack user and returns the raw value. */
export async function mintTicket(
  db: D1Database,
  input: { teamId: string; teamName: string | null; slackUserId: string },
  now = new Date(),
): Promise<string> {
  const ticket = randomToken();
  const expires = new Date(now.getTime() + TICKET_TTL_MS);
  await db.batch([
    // Lazy cleanup; the expires index keeps this cheap.
    db.prepare("DELETE FROM slack_link_tickets WHERE expires_at < ?").bind(now.toISOString()),
    db
      .prepare(
        `INSERT INTO slack_link_tickets
           (ticket_hash, team_id, team_name, slack_user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        await ticketHash(ticket),
        input.teamId,
        input.teamName,
        input.slackUserId,
        now.toISOString(),
        expires.toISOString(),
      ),
  ]);
  return ticket;
}

export async function findLink(
  db: D1Database,
  teamId: string,
  slackUserId: string,
): Promise<SlackUserLink | null> {
  const row = await db
    .prepare(
      "SELECT user_email, linked_at FROM slack_user_links WHERE team_id = ? AND slack_user_id = ?",
    )
    .bind(teamId, slackUserId)
    .first<{ user_email: string | null; linked_at: string }>();
  return row ? { userEmail: row.user_email, linkedAt: row.linked_at } : null;
}

export async function removeLink(db: D1Database, teamId: string, slackUserId: string) {
  await db
    .prepare("DELETE FROM slack_user_links WHERE team_id = ? AND slack_user_id = ?")
    .bind(teamId, slackUserId)
    .run();
}

/** The installed team's name, for the connect page. */
export async function teamName(db: D1Database, teamId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT team_name FROM slack_installations WHERE team_id = ?")
    .bind(teamId)
    .first<{ team_name: string | null }>();
  return row?.team_name ?? null;
}
