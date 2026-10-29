import { escapeHtml, renderEmailCard, resolveWebOrigin, type RenderedEmail } from "./card";

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

/** "225 MB of 250 MB", or an upload count. The operator FYI uses this too. */
function usageOf(event: UsageAlertEvent): string {
  return event.cap === "storage"
    ? `${formatBytes(event.used)} of ${formatBytes(event.limit)}`
    : `${formatCount(event.used)} of ${formatCount(event.limit)} uploads this month`;
}

function remedyLink(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="color:#b9b0cf;">${label}</a>`;
}

/** The template does not receive a calendar date. Counts reset on the UTC month. */
const UPLOAD_RESET = "They reset at the start of next month";

interface RemedyUrls {
  plan?: string;
  billingUrl: string;
  storageUrl: string;
}

function canUpgrade(urls: RemedyUrls): boolean {
  return urls.plan !== "pro";
}

function storageSubject(name: string, event: UsageAlertEvent): string {
  if (event.threshold >= 100) return `${name}'s storage is full`;
  if (event.threshold <= 50) return `${name} has used half its storage`;
  return `${name} is almost out of storage`;
}

function storageHeadline(event: UsageAlertEvent): string {
  return event.threshold >= 100 ? "Your storage is full" : "You're running low on storage";
}

function uploadsSubject(name: string, event: UsageAlertEvent): string {
  if (event.threshold >= 100) return `${name} hit this month's upload limit`;
  if (event.threshold <= 50) return `${name} has used half its uploads this month`;
  return `${name} is close to this month's upload limit`;
}

function uploadsHeadline(event: UsageAlertEvent): string {
  return event.threshold >= 100
    ? "You've hit this month's upload limit"
    : "You're close to this month's upload limit";
}

/** Mid-sentence "upgrade your plan", or a capital start when it opens the sentence. */
function upgradePhrase(urls: RemedyUrls, label: string): { html: string; text: string } | null {
  if (!canUpgrade(urls)) return null;
  return {
    html: remedyLink(urls.billingUrl, label),
    text: `${label} (${urls.billingUrl})`,
  };
}

function bucketPhrase(urls: RemedyUrls, label: string): { html: string; text: string } {
  return {
    html: remedyLink(urls.storageUrl, label),
    text: `${label} (${urls.storageUrl})`,
  };
}

function storageBody(
  name: string,
  event: UsageAlertEvent,
  urls: RemedyUrls,
): { html: string; text: string } {
  const limit = formatBytes(event.limit);
  if (event.threshold >= 100) {
    const fact = `${name} has used all ${limit}, so new uploads are paused. Everything you've already uploaded is safe and still works.`;
    const upgrade = upgradePhrase(urls, "Upgrade your plan");
    const bucket = bucketPhrase(
      urls,
      upgrade ? "connect your own bucket" : "Connect your own bucket",
    );
    const action = upgrade
      ? `${upgrade.text} or ${bucket.text} to start uploading again.`
      : `${bucket.text} to start uploading again.`;
    const actionHtml = upgrade
      ? `${upgrade.html} or ${bucket.html} to start uploading again.`
      : `${bucket.html} to start uploading again.`;
    return { html: `${escapeHtml(fact)} ${actionHtml}`, text: `${fact} ${action}` };
  }
  const fact = `${name} has used ${formatBytes(event.used)} of its ${limit}. Uploads keep working until it's full.`;
  const upgrade = upgradePhrase(urls, "upgrade your plan");
  const bucket = bucketPhrase(urls, "connect your own bucket");
  const action = upgrade
    ? `To get more room, ${upgrade.text} or ${bucket.text} (it isn't metered).`
    : `To get more room, ${bucket.text} (it isn't metered).`;
  const actionHtml = upgrade
    ? `To get more room, ${upgrade.html} or ${bucket.html} (it isn't metered).`
    : `To get more room, ${bucket.html} (it isn't metered).`;
  return { html: `${escapeHtml(fact)} ${actionHtml}`, text: `${fact} ${action}` };
}

function uploadsBody(
  name: string,
  event: UsageAlertEvent,
  urls: RemedyUrls,
): { html: string; text: string } {
  const fact =
    event.threshold >= 100
      ? `${name} has used all its uploads for this month.`
      : `${name} has used ${formatCount(event.used)} of its ${formatCount(event.limit)} uploads this month.`;
  const upgrade = upgradePhrase(urls, "upgrade now");
  const rest = upgrade
    ? `${UPLOAD_RESET}, or you can ${upgrade.text} to keep going.`
    : `${UPLOAD_RESET}.`;
  const restHtml = upgrade
    ? `${UPLOAD_RESET}, or you can ${upgrade.html} to keep going.`
    : `${UPLOAD_RESET}.`;
  return { html: `${escapeHtml(fact)} ${restHtml}`, text: `${fact} ${rest}` };
}

/**
 * One sweep can cross storage and uploads together. The subject follows the
 * fuller problem. The body states both, and still withholds an upgrade on Pro
 * and a bucket when only the upload count is involved.
 */
function alertCopy(
  name: string,
  events: UsageAlertEvent[],
  urls: RemedyUrls,
): { subject: string; title: string; html: string; text: string } {
  const storage = events.find((event) => event.cap === "storage");
  const uploads = events.find((event) => event.cap === "uploads");
  if (storage && uploads) {
    const storagePart = storageBody(name, storage, urls);
    const uploadsPart = uploadsBody(name, uploads, urls);
    const lead = storage.threshold >= 100 ? storage : uploads.threshold >= 100 ? uploads : storage;
    return {
      subject: lead.cap === "storage" ? storageSubject(name, lead) : uploadsSubject(name, lead),
      title: lead.cap === "storage" ? storageHeadline(lead) : uploadsHeadline(lead),
      html: `${storagePart.html} ${uploadsPart.html}`,
      text: `${storagePart.text} ${uploadsPart.text}`,
    };
  }
  const only = storage ?? uploads;
  if (!only) {
    return { subject: name, title: "Usage", html: "", text: "" };
  }
  const body =
    only.cap === "storage" ? storageBody(name, only, urls) : uploadsBody(name, only, urls);
  return {
    subject: only.cap === "storage" ? storageSubject(name, only) : uploadsSubject(name, only),
    title: only.cap === "storage" ? storageHeadline(only) : uploadsHeadline(only),
    html: body.html,
    text: body.text,
  };
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
  /** The workspace's billing plan, so the remedy copy stays honest (a `pro`
   * workspace can't "upgrade" further). Absent = treat as upgradeable. */
  plan?: string;
  webOrigin?: string;
}): RenderedEmail {
  const origin = resolveWebOrigin(ctx.webOrigin);
  const workspaceBase = `${origin}/account/workspaces/${encodeURIComponent(ctx.organizationSlug)}`;
  // Billing is where you upgrade and see the cap. The bucket section of the
  // Storage tab is where you connect your own bucket (`#bucket`).
  const billingUrl = `${workspaceBase}/billing`;
  const storageUrl = `${workspaceBase}/storage#bucket`;
  const settingsUrl = `${origin}/account/profile`;

  const events = ctx.events.slice(0, 2);
  const name = ctx.organizationName.trim() || ctx.organizationSlug;
  const urls = { plan: ctx.plan, billingUrl, storageUrl };
  const copy = alertCopy(name, events, urls);
  const hasStorage = events.some((event) => event.cap === "storage");
  const ctaLabel = hasStorage
    ? "Get more storage →"
    : canUpgrade(urls)
      ? "Upgrade your plan →"
      : "View billing →";

  return renderEmailCard({
    subject: copy.subject,
    preheader: copy.text,
    eyebrow: "Usage",
    title: copy.title,
    bodyHtml: copy.html,
    text: [
      copy.text,
      "",
      `${ctaLabel.replace(/ →$/u, "")}: ${billingUrl}`,
      "",
      "—",
      "uploads.sh · a Build Internet project",
      `Turn this notification off in your account settings: ${settingsUrl}`,
    ].join("\n"),
    cta: { url: billingUrl, label: ctaLabel },
    footNoteHtml: `You administer this workspace. <a href="${escapeHtml(settingsUrl)}" style="color:#b9b0cf;">Manage notifications</a> to turn this off.`,
    webOrigin: ctx.webOrigin,
  });
}

/** Hosted platform storage, or a customer bucket. Absent when the sweep didn't say. */
export type WorkspaceStorageMode = "hosted" | "byo";

/** Admin workspaces list, opened on this workspace's drawer (`?workspace=`). */
function adminWorkspaceUrl(webOrigin: string | undefined, slug: string): string {
  const origin = resolveWebOrigin(webOrigin);
  return `${origin}/admin?workspace=${encodeURIComponent(slug)}`;
}

function storageModeLine(mode: WorkspaceStorageMode | undefined): string {
  if (mode === "byo") return "BYO (the cap counts hosted files only)";
  if (mode === "hosted") return "hosted";
  return "unknown";
}

/**
 * Short FYI for the uploads.sh operator when a workspace's storage crosses
 * 90% or 100%. The auth worker sends this; the template only formats.
 */
export function renderStorageOperatorAlertEmail(ctx: {
  organizationName: string;
  organizationSlug: string;
  organizationId: string;
  event: UsageAlertEvent;
  storageMode?: WorkspaceStorageMode;
  /** Owner addresses. Empty means the org has no owner on file. */
  ownerEmails: string[];
  webOrigin?: string;
}): RenderedEmail {
  const origin = resolveWebOrigin(ctx.webOrigin);
  const adminUrl = adminWorkspaceUrl(origin, ctx.organizationSlug);
  const pct = displayPct(ctx.event);
  const reached = ctx.event.threshold >= 100;
  const name = ctx.organizationName.trim() || ctx.organizationSlug;
  const subject = reached
    ? `[storage] ${name} reached its storage limit`
    : `[storage] ${name} is at ${pct}% of its storage limit`;
  const owners = ctx.ownerEmails.map((email) => email.trim()).filter((email) => email.length > 0);
  const ownerLine = owners.length > 0 ? owners.join(", ") : "none";
  const lines = [
    `Workspace: ${name} (${ctx.organizationSlug})`,
    `Id: ${ctx.organizationId}`,
    `Usage: ${usageOf(ctx.event)} (${pct}%)`,
    `Storage: ${storageModeLine(ctx.storageMode)}`,
    `Owner: ${ownerLine}`,
  ];
  return renderEmailCard({
    subject,
    preheader: subject,
    eyebrow: "Storage",
    title: reached ? "Storage limit reached" : "Storage nearing its limit",
    bodyHtml: lines.map((line) => escapeHtml(line)).join("<br>"),
    text: [...lines, "", `Admin: ${adminUrl}`].join("\n"),
    cta: { url: adminUrl, label: "Open in admin →" },
    footNoteHtml: "Internal FYI for the uploads.sh operator.",
    webOrigin: origin,
  });
}
