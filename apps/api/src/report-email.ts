/**
 * Fire-and-forget operator mail for feedback reports (`POST /v1/reports`).
 * Never throws: mail must not fail a report that already landed in D1.
 */
import { renderReportEmail, type ReportEmailInput } from "@uploads/email";
import type { AbuseNotifyEnv } from "./abuse-email";

const FROM = { name: "uploads.sh", email: "noreply@uploads.sh" } as const;
export const REPORT_NOTIFY_TO = "hi@uploads.sh";

const MAX_PER_HOUR = 30;
const HOUR_MS = 3_600_000;

/** Hourly email cap so a flood of reports can't flood the inbox. Fail-open without KV. */
async function withinBudget(kv: AbuseNotifyEnv["REGISTRY"]): Promise<boolean> {
  if (!kv) return true;
  const key = `report:notify:${Math.floor(Date.now() / HOUR_MS)}`;
  const current = parseInt((await kv.get(key)) ?? "0", 10) || 0;
  if (current >= MAX_PER_HOUR) return false;
  await kv.put(key, String(current + 1), { expirationTtl: 3600 });
  return true;
}

export async function notifyReport(
  env: AbuseNotifyEnv,
  row: Omit<ReportEmailInput, "webOrigin">,
): Promise<void> {
  try {
    if (!(await withinBudget(env.REGISTRY))) {
      console.warn(
        JSON.stringify({ component: "reports", event: "notify-rate-capped", id: row.id }),
      );
      return;
    }
    const { subject, text, html } = renderReportEmail({
      ...row,
      webOrigin: env.WEB_ORIGIN || "https://uploads.sh",
    });
    if (!env.EMAIL) {
      console.warn(`[api email] no EMAIL binding — report not sent. "${subject}". id=${row.id}`);
      return;
    }
    await env.EMAIL.send({ to: REPORT_NOTIFY_TO, from: FROM, subject, text, html });
    console.log(JSON.stringify({ component: "reports", event: "notify-sent", id: row.id }));
  } catch (err) {
    console.error(
      JSON.stringify({
        component: "reports",
        event: "notify-error",
        id: row.id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
