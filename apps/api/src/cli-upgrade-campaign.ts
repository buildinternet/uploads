/**
 * Operator-run "update your CLI" campaign (/admin/email). Never runs on its
 * own: an operator picks a minimum version, checks the count, then sends.
 *
 * Recipients are people with product updates on (`notify_product_updates`),
 * not banned, whose newest CLI or `uploads mcp` seen in the last
 * `SEEN_WITHIN_DAYS` is below the minimum. A CLI older than 0.57.0 has no
 * version on record and counts as below any minimum. Credentials with no
 * user on record (legacy KV tokens) can't be reached and are left out.
 *
 * Each send is recorded in `email_campaign_sends` under
 * `cli-upgrade:<minimum>`, so sending again only reaches people this
 * campaign hasn't emailed yet. The auth worker signs the unsubscribe link and
 * sends, as with the weekly digest.
 */
import { ServiceUnavailableError, ValidationError } from "@uploads/errors";
import { primaryDbFor, type D1Queryable } from "./db-session";

const INTERNAL_ORIGIN = "https://auth.internal";
const SEEN_WITHIN_DAYS = 30;
/** Sends per click. The operator sends again for the rest. */
const BATCH_SIZE = 100;
const SAMPLE_SIZE = 10;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

export interface CliUpgradeRecipient {
  userId: string;
  email: string;
  /** Newest version seen, or null for a CLI too old to report one. */
  version: string | null;
}

export interface CliUpgradeCampaignResult {
  campaign: string;
  /** People who would get it now (not yet emailed by this campaign). */
  eligible: number;
  sample: { email: string; version: string | null }[];
  sent?: number;
  failed?: number;
}

function semverTriple(version: string | null): [number, number, number] | null {
  const match = version ? /^(\d+)\.(\d+)\.(\d+)/.exec(version) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** -1, 0 or 1. A missing or unparseable version sorts below every real one. */
export function compareCliVersions(a: string | null, b: string | null): number {
  const x = semverTriple(a);
  const y = semverTriple(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i += 1) {
    if (x[i]! !== y[i]!) return x[i]! < y[i]! ? -1 : 1;
  }
  return 0;
}

export function cliUpgradeCampaignId(minimumVersion: string): string {
  return `cli-upgrade:${minimumVersion}`;
}

export async function cliUpgradeRecipients(
  db: D1Queryable,
  minimumVersion: string,
  now = new Date(),
): Promise<CliUpgradeRecipient[]> {
  const since = new Date(now.getTime() - SEEN_WITHIN_DAYS * 86_400_000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT ca.user_id, u.email, ca.client_version
         FROM client_activity ca
         INNER JOIN user u ON u.id = ca.user_id
        WHERE ca.surface IN ('cli', 'mcp-local')
          AND ca.last_seen_at >= ?
          AND COALESCE(u.notify_product_updates, 1) = 1
          AND COALESCE(u.banned, 0) = 0
          AND NOT EXISTS (
            SELECT 1 FROM email_campaign_sends s
             WHERE s.campaign = ? AND s.user_id = u.id
          )`,
    )
    .bind(since, cliUpgradeCampaignId(minimumVersion))
    .all<{ user_id: string; email: string | null; client_version: string | null }>();

  // One person can use several tokens and machines: judge them by the newest.
  const newest = new Map<string, CliUpgradeRecipient>();
  for (const row of results ?? []) {
    if (!row.email) continue;
    const seen = newest.get(row.user_id);
    if (!seen || compareCliVersions(row.client_version, seen.version) > 0) {
      newest.set(row.user_id, {
        userId: row.user_id,
        email: row.email,
        version: row.client_version,
      });
    }
  }
  return [...newest.values()]
    .filter((r) => compareCliVersions(r.version, minimumVersion) < 0)
    .sort((a, b) => a.email.localeCompare(b.email));
}

/** Count (and with `send`, email the next batch of) the campaign's recipients. */
export async function runCliUpgradeCampaign(
  env: Env,
  input: { minimumVersion?: unknown; send?: unknown },
  now = new Date(),
): Promise<CliUpgradeCampaignResult> {
  const minimumVersion =
    typeof input.minimumVersion === "string" ? input.minimumVersion.trim() : "";
  if (!VERSION_RE.test(minimumVersion)) {
    throw new ValidationError("minimumVersion must look like 0.59.0", {
      code: "invalid_version",
    });
  }
  // Primary, so a send recorded by the previous click is never missed.
  const db = primaryDbFor(env);
  const campaign = cliUpgradeCampaignId(minimumVersion);
  const recipients = await cliUpgradeRecipients(db, minimumVersion, now);
  const sample = recipients
    .slice(0, SAMPLE_SIZE)
    .map((r) => ({ email: r.email, version: r.version }));
  if (input.send !== true) return { campaign, eligible: recipients.length, sample };

  const batch = recipients.slice(0, BATCH_SIZE);
  if (batch.length === 0) return { campaign, eligible: 0, sample, sent: 0, failed: 0 };
  let res: Response;
  try {
    res = await env.AUTH.fetch(`${INTERNAL_ORIGIN}/internal/product-updates/cli-upgrade/send`, {
      method: "POST",
      headers: { "x-uploads-internal": "1", "content-type": "application/json" },
      body: JSON.stringify({
        messages: batch.map((r) => ({
          userId: r.userId,
          to: r.email,
          currentVersion: r.version,
          minimumVersion,
        })),
      }),
    });
  } catch (err) {
    throw new ServiceUnavailableError("auth service is unavailable", {
      code: "auth_service_unavailable",
      cause: err,
    });
  }
  if (!res.ok) {
    throw new ServiceUnavailableError(`campaign send failed (${res.status})`, {
      code: "campaign_send_failed",
    });
  }
  const body = (await res.json().catch(() => ({}))) as { sent?: unknown };
  const sent = Array.isArray(body.sent)
    ? body.sent.filter((id): id is string => typeof id === "string")
    : [];
  if (sent.length > 0) {
    await db.batch(
      sent.map((userId) =>
        db
          .prepare(
            "INSERT OR IGNORE INTO email_campaign_sends (campaign, user_id, sent_at) VALUES (?, ?, ?)",
          )
          .bind(campaign, userId, now.toISOString()),
      ),
    );
  }
  console.log({
    event: "cli_upgrade_campaign_sent",
    campaign,
    sent: sent.length,
    batch: batch.length,
  });
  return {
    campaign,
    eligible: recipients.length - sent.length,
    sample,
    sent: sent.length,
    failed: batch.length - sent.length,
  };
}
