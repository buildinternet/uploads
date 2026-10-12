/**
 * Monday digest sweep. Reads activity in this worker (the tables live on the
 * shared D1), asks Jev which screenshot should be the highlight when the AI
 * binding is up, and posts the messages to the auth worker to sign
 * unsubscribe links and send.
 *
 * Each workspace with something to say gets its own email. A workspace with
 * no uploads, screenshots, or pull-request media is left out of the member
 * mail. The admin pulse also stays quiet when nothing changed and nothing
 * is near a plan limit. A storage snapshot alone does not send.
 */
import { digestDeliveryId, type WeeklyDigestMessage } from "@uploads/email";
import { workersAiClassifierRun } from "./classifier";
import type { D1Queryable } from "./db-session";
import { dbFor } from "./db-session";
import { loadDigestSources } from "./weekly-digest-data";
import {
  curateWorkspace,
  digestWindow,
  draftsForRecipient,
  slugsWorthCurating,
  type DigestCuration,
  type DigestRecipient,
  type WorkspaceDigestSource,
} from "./weekly-digest";

export const WEEKLY_DIGEST_CRON = "0 14 * * 1";
const INTERNAL_ORIGIN = "https://auth.internal";
const MARKER_TTL_S = 12 * 24 * 60 * 60;

export interface WeeklyDigestSweepResult {
  workspaces: number;
  recipients: number;
  sent: number;
  skipped: number;
  curated: number;
  errors: string[];
}

interface RecipientRow {
  user_id: string;
  email: string;
  name: string;
  digest: number;
  workspace_digest: number;
  slug: string;
  org_name: string;
  role: string;
}

async function loadRecipients(db: D1Queryable): Promise<DigestRecipient[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id AS user_id, u.email, u.name,
              m.notify_weekly_digest AS digest,
              m.notify_weekly_workspace_digest AS workspace_digest,
              o.slug AS slug, o.name AS org_name, m.role AS role
       FROM user u
       INNER JOIN member m ON m.user_id = u.id
       INNER JOIN organization o ON o.id = m.organization_id
       WHERE (m.notify_weekly_digest = 1 OR m.notify_weekly_workspace_digest = 1)
         AND COALESCE(u.banned, 0) = 0`,
    )
    .all<RecipientRow>();

  const byUser = new Map<string, DigestRecipient>();
  for (const row of results ?? []) {
    let recipient = byUser.get(row.user_id);
    if (!recipient) {
      recipient = {
        userId: row.user_id,
        email: row.email,
        name: row.name,
        memberships: [],
      };
      byUser.set(row.user_id, recipient);
    }
    recipient.memberships.push({
      slug: row.slug,
      orgName: row.org_name,
      role: row.role,
      digest: row.digest === 1,
      workspaceDigest: row.workspace_digest === 1,
    });
  }
  return [...byUser.values()];
}

async function sentThisWeek(kv: KVNamespace, weekId: string): Promise<Set<string>> {
  const sent = new Set<string>();
  const prefix = `digest:sent:${weekId}:`;
  let cursor: string | undefined;
  do {
    const page: KVNamespaceListResult<unknown> = await kv.list({ prefix, cursor });
    for (const key of page.keys) sent.add(key.name.slice(prefix.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return sent;
}

async function postDigests(
  env: Env,
  messages: WeeklyDigestMessage[],
): Promise<{ sent: string[]; failed: string[] }> {
  if (!env.AUTH) {
    console.warn(JSON.stringify({ message: "weekly_digest_no_auth_binding" }));
    return { sent: [], failed: messages.map((message) => message.userId) };
  }
  const res = await env.AUTH.fetch(`${INTERNAL_ORIGIN}/internal/weekly-digest/send`, {
    method: "POST",
    headers: { "x-uploads-internal": "1", "content-type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) {
    throw new Error(`weekly digest notify failed: ${res.status}`);
  }
  const body = (await res.json()) as { sent?: unknown; failed?: unknown };
  const sent = Array.isArray(body.sent)
    ? body.sent.filter((id): id is string => typeof id === "string")
    : [];
  const failed = Array.isArray(body.failed)
    ? body.failed.filter((id): id is string => typeof id === "string")
    : [];
  return { sent, failed };
}

export async function runWeeklyDigestSweep(
  env: Env,
  deps?: { now?: Date; db?: D1Queryable },
): Promise<WeeklyDigestSweepResult> {
  const now = deps?.now ?? new Date();
  const window = digestWindow(now);
  const result: WeeklyDigestSweepResult = {
    workspaces: 0,
    recipients: 0,
    sent: 0,
    skipped: 0,
    curated: 0,
    errors: [],
  };

  const db = deps?.db ?? dbFor(env);
  const sources = await loadDigestSources(db, env.REGISTRY, now);
  result.workspaces = sources.size;
  const recipients = await loadRecipients(db);
  const already = await sentThisWeek(env.REGISTRY, window.sinceDay);

  const unsentSlugs = new Set<string>();
  for (const recipient of recipients) {
    for (const draft of draftsForRecipient(recipient, sources, window.weekLabel)) {
      const id = digestDeliveryId(draft);
      const slug = draft.user?.workspaceSlug;
      if (id && slug && !already.has(id)) unsentSlugs.add(slug);
    }
  }

  const curation = new Map<string, DigestCuration>();
  if (env.AI && unsentSlugs.size > 0) {
    const run = workersAiClassifierRun(env);
    for (const slug of slugsWorthCurating(recipients, sources)) {
      if (!unsentSlugs.has(slug)) continue;
      const source = sources.get(slug);
      if (!source) continue;
      curation.set(slug, await curateWorkspace(source, run));
      result.curated += 1;
    }
  }

  const messages: WeeklyDigestMessage[] = [];
  for (const recipient of recipients) {
    const drafts = draftsForRecipient(recipient, sources, window.weekLabel, curation);
    const fresh = drafts.filter((draft) => {
      const id = digestDeliveryId(draft);
      return id !== null && !already.has(id);
    });
    if (drafts.length > 0 && fresh.length === 0) result.skipped += 1;
    messages.push(...fresh);
  }
  result.recipients = messages.length;

  if (messages.length === 0) {
    console.log(JSON.stringify({ message: "weekly_digest_sweep", ...result }));
    return result;
  }

  try {
    const delivered = await postDigests(env, messages);
    for (const id of delivered.sent) {
      await env.REGISTRY.put(`digest:sent:${window.sinceDay}:${id}`, "1", {
        expirationTtl: MARKER_TTL_S,
      });
    }
    result.sent = delivered.sent.length;
    if (delivered.failed.length > 0) {
      result.errors.push(`${delivered.failed.length} sends failed`);
    }
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  console.log(JSON.stringify({ message: "weekly_digest_sweep", ...result }));
  return result;
}

export type { WorkspaceDigestSource };
