import { escapeHtml, renderEmailCard, type RenderedEmail } from "./card";

/** The one image that opens a member digest. `url` is the file; `href` is the repo or pull request. */
export interface WeeklyDigestHighlight {
  url: string;
  embedUrl?: string | null;
  caption: string;
  href?: string;
  hrefLabel?: string;
}

export interface WeeklyDigestTopPull {
  title: string;
  repo: string;
  number: number;
  href?: string;
  state?: "open" | "closed" | "merged";
  thumbnailUrl?: string;
  thumbnailEmbedUrl?: string | null;
}

/**
 * One line in an admin pulse. Activity lines are plain text. The storage
 * footnote is the only note that may carry `href`.
 */
export interface WeeklyDigestNote {
  text: string;
  href?: string;
}

export interface WeeklyDigestUser {
  /** Set when the week's file activity is in one workspace. */
  workspaceName?: string;
  workspaceSlug?: string;
  highlight?: WeeklyDigestHighlight;
  topPull?: WeeklyDigestTopPull;
  uploads: number;
  repos: number;
}

export interface WeeklyDigestPulse {
  uploads: number;
  /** This week minus the previous week. */
  uploadsDelta: number;
  activeMembers: number;
  /** People whose first activity in the workspace fell in this week. */
  activeMembersNew: number;
  storageBytes: number;
  /** Net bytes added this week (uploads minus deletes). */
  storageDeltaBytes: number;
  /** Plain sentences. Not links. */
  notes: WeeklyDigestNote[];
  /** Small muted line under the pulse. `href` is an optional billing link. */
  storageNote?: WeeklyDigestNote;
}

export interface WeeklyDigestPulseBlock {
  slug: string;
  name: string;
  pulse: WeeklyDigestPulse;
}

export type WeeklyDigestKind = "digest" | "workspace";

/**
 * Wire payload the API sweep posts to the auth worker. Unsubscribe URLs are
 * minted there, from `unsubscribes`, so the signing secret never leaves auth.
 */
export interface WeeklyDigestMessage {
  userId: string;
  to: string;
  weekLabel: string;
  user?: WeeklyDigestUser;
  pulses: WeeklyDigestPulseBlock[];
  unsubscribes: WeeklyDigestKind[];
}

/** KV and send-result id for one person and one workspace. */
export function digestDeliveryId(message: {
  userId: string;
  user?: { workspaceSlug?: string };
  pulses: { slug: string }[];
}): string | null {
  const slug = message.user?.workspaceSlug || message.pulses[0]?.slug || "";
  if (!message.userId || !slug || slug.includes("|")) return null;
  return `${message.userId}|${slug}`;
}

export interface WeeklyDigestEmailInput {
  weekLabel: string;
  user?: WeeklyDigestUser;
  pulses?: WeeklyDigestPulseBlock[];
  unsubscribeDigestUrl?: string;
  unsubscribeWorkspaceUrl?: string;
  webOrigin?: string;
}

const LINK = "color:#b9b0cf;text-decoration:underline;";
const META =
  "font-family:ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6;color:#8a8a83;";
const TITLE =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";

function formatBytes(n: number): string {
  const value = Math.abs(n);
  if (!Number.isFinite(value) || value < 1000) return `${Math.max(0, Math.round(value))} B`;
  const units = ["kB", "MB", "GB", "TB", "PB"];
  let scaled = value;
  let unit = -1;
  do {
    scaled /= 1000;
    unit += 1;
  } while (scaled >= 1000 && unit < units.length - 1);
  const rounded =
    scaled >= 10 || Number.isInteger(scaled) ? Math.round(scaled) : Number(scaled.toFixed(1));
  return `${rounded} ${units[unit]}`;
}

function formatCount(n: number): string {
  return Math.max(0, Math.round(Math.abs(n))).toLocaleString("en-US");
}

function signedDelta(n: number, body: string): string {
  if (n === 0) return "no change";
  return n > 0 ? `+${body}` : `-${body}`;
}

/** https URLs only. A metadata value must not become a javascript: link. */
function safeHttps(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function resolveHref(href: string | undefined, webOrigin: string): string | null {
  if (!href) return null;
  if (href.startsWith("/account/")) return safeHttps(`${webOrigin}${href}`);
  return safeHttps(href);
}

function linkHtml(href: string | null, label: string): string {
  const text = escapeHtml(label);
  if (!href) return text;
  return `<a href="${escapeHtml(href)}" style="${LINK}">${text}</a>`;
}

function filesPath(slug: string): string {
  return `/account/workspaces/${encodeURIComponent(slug)}/files`;
}

function statLine(uploads: number, repos: number): string {
  const files = uploads === 1 ? "1 upload" : `${formatCount(uploads)} uploads`;
  if (repos <= 0) return files;
  const repoLabel = repos === 1 ? "1 repo" : `${formatCount(repos)} repos`;
  return `${files} across ${repoLabel}`;
}

function stateLabel(state: WeeklyDigestTopPull["state"]): string | null {
  if (state === "open") return "Open";
  if (state === "merged") return "Merged";
  if (state === "closed") return "Closed";
  return null;
}

function highlightBlock(
  highlight: WeeklyDigestHighlight,
  webOrigin: string,
): { html: string; text: string } {
  const fileHref = safeHttps(highlight.url);
  if (!fileHref) return { html: "", text: "" };
  const src = safeHttps(highlight.embedUrl) ?? fileHref;
  const link = resolveHref(highlight.href, webOrigin);
  const imageHref = link ?? fileHref;
  const caption = highlight.caption.trim();
  const hrefLabel = highlight.hrefLabel?.trim();
  const showLink = Boolean(link && hrefLabel && hrefLabel !== caption);
  const html = `<a href="${escapeHtml(imageHref)}" style="text-decoration:none;">
      <img src="${escapeHtml(src)}" width="456" alt="${escapeHtml(caption)}" style="display:block;width:100%;max-width:456px;height:auto;border:0;border-radius:10px;">
    </a>
    <p style="margin:10px 0 0;${TITLE}font-size:15px;line-height:1.4;color:#ececea;">${escapeHtml(caption)}</p>
    ${showLink ? `<p style="margin:4px 0 0;">${linkHtml(link, hrefLabel ?? "")}</p>` : ""}`;
  const text = [caption, showLink ? `${hrefLabel} (${link})` : fileHref].join("\n");
  return { html, text };
}

function topPullBlock(pull: WeeklyDigestTopPull): { html: string; text: string } {
  const href = safeHttps(pull.href);
  const title = linkHtml(href, pull.title);
  const state = stateLabel(pull.state);
  const meta = [pull.repo, state].filter((part): part is string => Boolean(part)).join(" · ");
  const thumbHref = safeHttps(pull.thumbnailUrl);
  const thumbSrc = thumbHref ? (safeHttps(pull.thumbnailEmbedUrl) ?? thumbHref) : null;
  const thumb = thumbSrc
    ? `<td style="width:96px;padding-right:12px;vertical-align:top;">
        <a href="${escapeHtml(href ?? thumbHref ?? thumbSrc)}" style="text-decoration:none;">
          <img src="${escapeHtml(thumbSrc)}" width="96" alt="" style="display:block;width:96px;height:auto;border:0;border-radius:8px;">
        </a>
      </td>`
    : "";
  const html = `<p style="margin:18px 0 8px;${META}text-transform:uppercase;letter-spacing:.08em;">Top pull request</p>
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      ${thumb}
      <td style="vertical-align:top;">
        <div style="${TITLE}font-size:15px;line-height:1.4;color:#ececea;">${title}</div>
        <div style="${META}">${escapeHtml(meta)}</div>
      </td>
    </tr></table>`;
  const text = ["Top pull request:", `${pull.title}${state ? ` (${state})` : ""}`, meta, href ?? ""]
    .filter((part) => part.length > 0)
    .join("\n");
  return { html, text };
}

function userBlock(user: WeeklyDigestUser, webOrigin: string): { html: string; text: string } {
  const highlight = user.highlight
    ? highlightBlock(user.highlight, webOrigin)
    : { html: "", text: "" };
  const pull = user.topPull ? topPullBlock(user.topPull) : { html: "", text: "" };
  const stats = statLine(user.uploads, user.repos);
  return {
    html: `${highlight.html}${pull.html}<p style="margin:16px 0 0;">${escapeHtml(stats)}</p>`,
    text: [highlight.text, pull.text, stats].filter((part) => part.length > 0).join("\n"),
  };
}

function pulseNumbers(pulse: WeeklyDigestPulse): { html: string; text: string } {
  const cells = [
    {
      value: formatCount(pulse.uploads),
      label: "uploads",
      delta: signedDelta(pulse.uploadsDelta, formatCount(pulse.uploadsDelta)),
    },
    {
      value: formatCount(pulse.activeMembers),
      label: pulse.activeMembers === 1 ? "active member" : "active members",
      delta:
        pulse.activeMembersNew > 0 ? `+${formatCount(pulse.activeMembersNew)} new` : "no change",
    },
    {
      value: formatBytes(pulse.storageBytes),
      label: "storage",
      delta: signedDelta(pulse.storageDeltaBytes, formatBytes(pulse.storageDeltaBytes)),
    },
  ];
  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;"><tr>${cells
    .map(
      (cell) => `<td style="width:33%;vertical-align:top;padding:0 8px 0 0;">
        <div style="${TITLE}font-size:22px;line-height:1.2;font-weight:600;color:#ececea;">${escapeHtml(cell.value)}</div>
        <div style="${META}">${escapeHtml(cell.label)}</div>
        <div style="${META}">${escapeHtml(cell.delta)}</div>
      </td>`,
    )
    .join("")}</tr></table>`;
  const text = cells.map((cell) => `${cell.value} ${cell.label}, ${cell.delta}`).join("\n");
  return { html, text };
}

const FOOT =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#8a8a83;";

function activityLines(notes: WeeklyDigestNote[]): { html: string; text: string } {
  const lines = notes.map((note) => note.text.trim()).filter((text) => text.length > 0);
  if (lines.length === 0) return { html: "", text: "" };
  const html = `<ul style="margin:14px 0 0;padding:0 0 0 18px;">${lines
    .map(
      (text) =>
        `<li style="margin:0 0 6px;${TITLE}font-size:15px;line-height:1.45;color:#b3b3ad;">${escapeHtml(text)}</li>`,
    )
    .join("")}</ul>`;
  return { html, text: lines.map((text) => `- ${text}`).join("\n") };
}

function storageFootnote(
  note: WeeklyDigestNote | undefined,
  webOrigin: string,
): { html: string; text: string } {
  const sentence = note?.text.trim().replace(/\.+$/u, "") ?? "";
  if (!sentence) return { html: "", text: "" };
  const href = resolveHref(note?.href, webOrigin);
  // The pulse note's href is the billing tab. Offer the bucket beside it.
  const bucket = href?.endsWith("/billing")
    ? `${href.slice(0, -"/billing".length)}/storage#bucket`
    : null;
  const link = href
    ? ` <a href="${escapeHtml(href)}" style="color:#8a8a83;text-decoration:underline;">View billing</a>${
        bucket
          ? ` or <a href="${escapeHtml(bucket)}" style="color:#8a8a83;text-decoration:underline;">connect a bucket</a>`
          : ""
      }`
    : "";
  const text = !href
    ? `${sentence}.`
    : bucket
      ? `${sentence}. View billing: ${href} or connect a bucket: ${bucket}`
      : `${sentence}. View billing: ${href}`;
  return {
    html: `<p style="margin:18px 0 0;${FOOT}">${escapeHtml(sentence)}.${link}</p>`,
    text,
  };
}

function pulseBody(
  block: WeeklyDigestPulseBlock,
  webOrigin: string,
): { html: string; text: string } {
  const numbers = pulseNumbers(block.pulse);
  const lines = activityLines(block.pulse.notes);
  const foot = storageFootnote(block.pulse.storageNote, webOrigin);
  return {
    html: `${numbers.html}${lines.html}${foot.html}`,
    text: [numbers.text, lines.text, foot.text].filter((part) => part.length > 0).join("\n"),
  };
}

function chosenPulse(input: WeeklyDigestEmailInput): WeeklyDigestPulseBlock | undefined {
  const pulses = input.pulses ?? [];
  const slug = input.user?.workspaceSlug;
  if (slug) return pulses.find((pulse) => pulse.slug === slug);
  return pulses[0];
}

function workspaceIdentity(input: WeeklyDigestEmailInput): { name?: string; slug?: string } {
  const pulse = chosenPulse(input);
  const name = input.user?.workspaceName?.trim() || pulse?.name?.trim() || undefined;
  const slug = input.user?.workspaceSlug || pulse?.slug;
  return { name, slug };
}

function unsubscribeNote(
  input: WeeklyDigestEmailInput,
  workspaceName: string | undefined,
): { html: string; text: string } {
  const links: { html: string; text: string }[] = [];
  const digest = safeHttps(input.unsubscribeDigestUrl);
  const workspace = safeHttps(input.unsubscribeWorkspaceUrl);
  const name = workspaceName?.trim();
  const memberLabel = name
    ? `Unsubscribe from ${name}'s weekly summary`
    : "Unsubscribe from this weekly summary";
  const adminLabel = name
    ? `Unsubscribe from ${name}'s admin pulse`
    : "Unsubscribe from this admin pulse";
  if (digest) {
    links.push({
      html: `<a href="${escapeHtml(digest)}" style="${LINK}">${escapeHtml(memberLabel)}</a>`,
      text: `${memberLabel}: ${digest}`,
    });
  }
  if (workspace) {
    links.push({
      html: `<a href="${escapeHtml(workspace)}" style="${LINK}">${escapeHtml(adminLabel)}</a>`,
      text: `${adminLabel}: ${workspace}`,
    });
  }
  if (links.length === 0) return { html: "", text: "" };
  return {
    html: links.map((link) => link.html).join("<br>"),
    text: links.map((link) => link.text).join("\n"),
  };
}

function destination(slug: string | undefined, webOrigin: string): string | null {
  if (!slug) return null;
  return resolveHref(filesPath(slug), webOrigin);
}

/** Weekly digest card. One workspace per message. Callers skip an empty week. */
export function renderWeeklyDigestEmail(input: WeeklyDigestEmailInput): RenderedEmail {
  const webOrigin = (input.webOrigin || "https://uploads.sh").replace(/\/$/, "");
  const { name, slug } = workspaceIdentity(input);
  const pulse = chosenPulse(input);
  const adminOnly = !input.user && Boolean(pulse);
  const week = input.weekLabel;
  const subject = name
    ? adminOnly
      ? `${name} admin pulse (${week})`
      : `Your week in ${name} (${week})`
    : adminOnly
      ? `Admin pulse (${week})`
      : `Your week (${week})`;
  const title = name
    ? adminOnly
      ? name
      : `Your week in ${name}`
    : adminOnly
      ? "Admin pulse"
      : "Your week";
  const user = input.user ? userBlock(input.user, webOrigin) : { html: "", text: "" };
  const pulseHtml = pulse ? pulseBody(pulse, webOrigin) : { html: "", text: "" };
  const unsub = unsubscribeNote(input, name);
  const see = destination(slug, webOrigin);
  const divider = `<div style="border-top:1px solid #232327;margin:18px 0;"></div>`;
  const adminHeading =
    input.user && pulse
      ? `<p style="margin:0 0 10px;${META}text-transform:uppercase;letter-spacing:.08em;">Admin pulse</p>`
      : "";
  const bodyHtml = [
    user.html,
    pulse ? `${user.html ? divider : ""}${adminHeading}${pulseHtml.html}` : "",
  ].join("");
  const text = [
    subject,
    user.text,
    pulseHtml.text,
    see ? `See your full week: ${see}` : "",
    unsub.text,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
  const preheader = input.user
    ? statLine(input.user.uploads, input.user.repos)
    : name
      ? `${name} admin pulse`
      : `Admin pulse, ${week}`;

  return renderEmailCard({
    subject,
    preheader,
    eyebrow: adminOnly ? "Admin pulse" : "Weekly digest",
    title,
    bodyHtml,
    text,
    cta: see ? { url: see, label: "See your full week →" } : undefined,
    footNoteHtml: unsub.html || undefined,
    webOrigin,
  });
}
