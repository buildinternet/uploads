/**
 * Fire-and-forget abuse-report mail → abuse@uploads.sh.
 * Never throws — mail must not fail a report that already landed in D1.
 */
import { renderAbuseReportEmail } from "@uploads/email";

const FROM = { name: "uploads.sh", email: "noreply@uploads.sh" } as const;
export const ABUSE_NOTIFY_TO = "abuse@uploads.sh";

const DEFAULT_MAX_PER_HOUR = 20;
const HOUR_MS = 3_600_000;

type NotifyKv = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
};

export type AbuseNotifyEnv = {
  EMAIL?: {
    send: (message: {
      to: string;
      from: { name: string; email: string };
      subject: string;
      text?: string;
      html?: string;
    }) => Promise<unknown>;
  };
  WEB_ORIGIN?: string;
  REGISTRY?: NotifyKv;
  ABUSE_NOTIFY_MAX_PER_HOUR?: string;
};

export type AbuseNotifyRow = {
  id: string;
  reason: string;
  message: string | null;
  contact: string | null;
  pageUrl: string;
  workspace: string | null;
  objectKey: string | null;
  surface: string;
  createdAt: string;
};

/** Hourly email cap. Fail-open without KV. Rows are still stored when capped. */
export async function withinAbuseNotifyBudget(
  kv: NotifyKv | undefined,
  max: number,
): Promise<boolean> {
  if (!kv) return true;
  const key = `abuse:notify:${Math.floor(Date.now() / HOUR_MS)}`;
  const current = parseInt((await kv.get(key)) ?? "0", 10) || 0;
  if (current >= max) return false;
  await kv.put(key, String(current + 1), { expirationTtl: 3600 });
  return true;
}

export async function notifyAbuseReport(env: AbuseNotifyEnv, row: AbuseNotifyRow): Promise<void> {
  try {
    const max = parseInt(env.ABUSE_NOTIFY_MAX_PER_HOUR ?? "", 10) || DEFAULT_MAX_PER_HOUR;
    if (!(await withinAbuseNotifyBudget(env.REGISTRY, max))) {
      console.warn(
        JSON.stringify({ component: "abuse", event: "notify-rate-capped", id: row.id, max }),
      );
      return;
    }

    const { subject, text, html } = renderAbuseReportEmail({
      ...row,
      webOrigin: env.WEB_ORIGIN || "https://uploads.sh",
    });

    if (!env.EMAIL) {
      console.warn(
        `[api email] no EMAIL binding — abuse not sent. To: ${ABUSE_NOTIFY_TO}. "${subject}". id=${row.id}`,
      );
      return;
    }

    await env.EMAIL.send({ to: ABUSE_NOTIFY_TO, from: FROM, subject, text, html });
    console.log(JSON.stringify({ component: "abuse", event: "notify-sent", id: row.id }));
  } catch (err) {
    console.error(
      JSON.stringify({
        component: "abuse",
        event: "notify-error",
        id: row.id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
