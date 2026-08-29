import { escapeHtml, renderEmailCard, resolveWebOrigin, strong, type RenderedEmail } from "./card";

/** Which cap a usage alert is about. Storage is cumulative; uploads reset monthly. */
export type UsageAlertCap = "storage" | "uploads";

/** The bands we alert on, as whole-percent thresholds of a cap. */
export type UsageAlertThreshold = 50 | 90 | 100;

/**
 * One cap crossing a new band. `used`/`limit` are raw (bytes for storage,
 * counts for uploads); the template formats them and derives the displayed
 * percentage, so senders never format numbers themselves.
 */
export interface UsageAlertEvent {
  cap: UsageAlertCap;
  threshold: UsageAlertThreshold;
  used: number;
  limit: number;
}

/** Decimal byte units (caps are decimal — 250 MB = 250_000_000). */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return `${Math.max(0, Math.round(n))} B`;
  const units = ["kB", "MB", "GB", "TB", "PB"];
  let value = n;
  let unit = -1;
  do {
    value /= 1000;
    unit += 1;
  } while (value >= 1000 && unit < units.length - 1);
  const rounded =
    value >= 10 || Number.isInteger(value) ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded} ${units[unit]}`;
}

function formatCount(n: number): string {
  return Math.max(0, Math.round(n)).toLocaleString("en-US");
}

/** Whole-percent of the cap in use, clamped to [0, 100] for display. */
function displayPct(event: UsageAlertEvent): number {
  if (!(event.limit > 0)) return 0;
  return Math.min(100, Math.max(0, Math.floor((event.used / event.limit) * 100)));
}

function capNoun(cap: UsageAlertCap): string {
  return cap === "storage" ? "storage" : "monthly uploads";
}

function capLabel(cap: UsageAlertCap): string {
  return cap === "storage" ? "Storage" : "Monthly uploads";
}

function usageOf(event: UsageAlertEvent): string {
  return event.cap === "storage"
    ? `${formatBytes(event.used)} of ${formatBytes(event.limit)}`
    : `${formatCount(event.used)} of ${formatCount(event.limit)} uploads this month`;
}

/** One "Storage — 90% used (225 MB of 250 MB)" line for the card body. */
function eventLineHtml(event: UsageAlertEvent): string {
  const state = event.threshold >= 100 ? "limit reached" : `${displayPct(event)}% used`;
  return `${strong(capLabel(event.cap))} — ${escapeHtml(`${state} (${usageOf(event)})`)}`;
}

function eventLineText(event: UsageAlertEvent): string {
  const state = event.threshold >= 100 ? "limit reached" : `${displayPct(event)}% used`;
  return `${capLabel(event.cap)} — ${state} (${usageOf(event)})`;
}

/**
 * Notify a workspace's admins/owners when its storage and/or upload usage
 * crosses a 50 / 90 / 100% band. Sent from the daily usage sweep. One email
 * covers every cap that crossed a new band in the same sweep (usually one).
 */
export function renderUsageAlertEmail(ctx: {
  organizationName: string;
  organizationSlug: string;
  events: UsageAlertEvent[];
  webOrigin?: string;
}): RenderedEmail {
  const origin = resolveWebOrigin(ctx.webOrigin);
  const manageUrl = `${origin}/account/workspaces/${ctx.organizationSlug}/settings`;
  const settingsUrl = `${origin}/account/profile`;

  const events = ctx.events.slice(0, 2);
  const anyReached = events.some((e) => e.threshold >= 100);
  const single = events.length === 1;
  const only = events[0];

  // Subject / title / lead vary by whether a hard limit was hit and whether one
  // cap or both crossed. Single-cap subjects name the cap; multi-cap generalize.
  const noun = single ? capNoun(only.cap) : "usage";
  const subject = anyReached
    ? `${ctx.organizationName} has reached its ${noun} limit on uploads.sh`
    : single
      ? `${ctx.organizationName} is at ${displayPct(only)}% of its ${noun} limit on uploads.sh`
      : `${ctx.organizationName} is approaching its ${noun} limits on uploads.sh`;
  const title = anyReached ? "Usage limit reached" : "Approaching a usage limit";
  const lead = anyReached
    ? `${ctx.organizationName} has reached a usage limit on uploads.sh.`
    : `${ctx.organizationName} is approaching a usage limit on uploads.sh.`;

  const linesHtml = events.map((e) => `<br>${eventLineHtml(e)}`).join("");
  const bodyHtml = `${escapeHtml(lead)}${linesHtml}`;

  return renderEmailCard({
    subject,
    preheader: lead,
    eyebrow: "Usage",
    title,
    bodyHtml,
    text: [
      lead,
      "",
      ...events.map(eventLineText),
      "",
      `Manage this workspace: ${manageUrl}`,
      "",
      "—",
      "uploads.sh · a Build Internet project",
      `Turn this notification off in your account settings: ${settingsUrl}`,
    ].join("\n"),
    cta: { url: manageUrl, label: "Manage workspace →" },
    footNoteHtml: `You administer this workspace. <a href="${escapeHtml(settingsUrl)}" style="color:#b9b0cf;">Manage notifications</a> to turn this off.`,
    webOrigin: ctx.webOrigin,
  });
}
