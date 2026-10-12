import { escapeHtml, renderEmailCard, strong, type RenderedEmail } from "./card";

/** One public image from the week. `url` is the stable link; `embedUrl` is the img src. */
export interface WeeklyDigestShot {
  url: string;
  embedUrl?: string | null;
  label: string;
}

export interface WeeklyDigestCount {
  name: string;
  count: number;
}

export interface WeeklyDigestLink {
  label: string;
  href?: string;
  detail?: string;
}

export interface WeeklyDigestPage {
  path: string;
  count: number;
}

/** Usage and people, present only on the workspace digest for an admin. */
export interface WeeklyDigestAdmin {
  storageBytes: number;
  objects: number;
  uploadsThisMonth: number;
  newMembers: number;
  activePeople: number;
}

/** One workspace block inside the weekly email. */
export interface WeeklyDigestSection {
  slug: string;
  name: string;
  blurb: string;
  uploads: number;
  bytesAdded: number;
  repos: WeeklyDigestCount[];
  screenshots: WeeklyDigestShot[];
  pulls: WeeklyDigestLink[];
  issues: WeeklyDigestLink[];
  pages: WeeklyDigestPage[];
  galleries: string[];
  galleryCount: number;
  feeds: number;
  admin?: WeeklyDigestAdmin;
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
  sections: WeeklyDigestSection[];
  omittedWorkspaces: number;
  unsubscribes: WeeklyDigestKind[];
}

export interface WeeklyDigestEmailInput {
  weekLabel: string;
  sections: WeeklyDigestSection[];
  omittedWorkspaces?: number;
  /** Opt out of the member digest. */
  unsubscribeDigestUrl?: string;
  /** Opt out of the workspace digest. */
  unsubscribeWorkspaceUrl?: string;
  webOrigin?: string;
}

const LINK = "color:#b9b0cf;text-decoration:underline;";
const META =
  "font-family:ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6;color:#8a8a83;";

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

function linkHtml(href: string | undefined, label: string): string {
  const safe = safeHttps(href);
  const text = escapeHtml(label);
  if (!safe) return text;
  return `<a href="${escapeHtml(safe)}" style="${LINK}">${text}</a>`;
}

function itemLine(item: WeeklyDigestLink): { html: string; text: string } {
  const extra = item.detail ? ` — ${item.detail}` : "";
  return {
    html: `${linkHtml(item.href, item.label)}${escapeHtml(extra)}`,
    text: `${item.label}${extra}${item.href ? ` (${item.href})` : ""}`,
  };
}

function bulletList(items: { html: string; text: string }[]): { html: string; text: string } {
  if (items.length === 0) return { html: "", text: "" };
  return {
    html: `<ul style="margin:0 0 14px;padding-left:18px;">${items
      .map((item) => `<li style="margin:0 0 4px;">${item.html}</li>`)
      .join("")}</ul>`,
    text: items.map((item) => `- ${item.text}`).join("\n"),
  };
}

function heading(label: string): string {
  return `<p style="margin:0 0 4px;${META}text-transform:uppercase;letter-spacing:.08em;">${escapeHtml(label)}</p>`;
}

function screenshotBlock(shots: WeeklyDigestShot[]): { html: string; text: string } {
  const usable = shots.flatMap((shot) => {
    const href = safeHttps(shot.url);
    if (!href) return [];
    const src = safeHttps(shot.embedUrl) ?? href;
    return [{ ...shot, href, src }];
  });
  if (usable.length === 0) return { html: "", text: "" };
  const cells = usable
    .map(
      (shot) => `<tr><td style="padding:0 0 12px;">
        <a href="${escapeHtml(shot.href)}" style="text-decoration:none;">
          <img src="${escapeHtml(shot.src)}" width="240" alt="${escapeHtml(shot.label)}" style="display:block;width:240px;max-width:100%;height:auto;border:0;border-radius:8px;">
        </a>
        <div style="${META}padding-top:4px;">${escapeHtml(shot.label)}</div>
      </td></tr>`,
    )
    .join("");
  return {
    html: `${heading("Screenshots")}<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 8px;">${cells}</table>`,
    text: ["Screenshots:", ...usable.map((shot) => `- ${shot.label}: ${shot.href}`)].join("\n"),
  };
}

function statsText(section: WeeklyDigestSection): string | null {
  const parts: string[] = [];
  if (section.uploads > 0) {
    const files = `${formatCount(section.uploads)} ${section.uploads === 1 ? "file" : "files"} uploaded`;
    parts.push(
      section.bytesAdded > 0 ? `${files}, ${formatBytes(section.bytesAdded)} added` : files,
    );
  } else if (section.bytesAdded > 0) {
    parts.push(`${formatBytes(section.bytesAdded)} added`);
  }
  if (parts.length === 0) return null;
  return parts.join(" · ");
}

function galleryText(section: WeeklyDigestSection): string | null {
  if (section.galleryCount <= 0 && section.feeds <= 0) return null;
  const bits: string[] = [];
  if (section.galleryCount > 0) {
    const names = section.galleries.slice(0, 3).join(", ");
    const extra = section.galleryCount - section.galleries.length;
    const label = section.galleryCount === 1 ? "gallery" : "galleries";
    bits.push(
      names
        ? `${section.galleryCount} ${label} (${names}${extra > 0 ? `, and ${extra} more` : ""})`
        : `${section.galleryCount} ${label}`,
    );
  }
  if (section.feeds > 0) {
    bits.push(`${section.feeds} ${section.feeds === 1 ? "change feed" : "change feeds"}`);
  }
  return bits.join(" · ");
}

function adminText(admin: WeeklyDigestAdmin): string | null {
  const parts: string[] = [];
  if (admin.storageBytes > 0 || admin.objects > 0) {
    parts.push(
      `Storage ${formatBytes(admin.storageBytes)} across ${formatCount(admin.objects)} ${admin.objects === 1 ? "object" : "objects"}`,
    );
  }
  if (admin.uploadsThisMonth > 0) {
    parts.push(`${formatCount(admin.uploadsThisMonth)} uploads this month`);
  }
  if (admin.newMembers > 0) {
    parts.push(
      `${formatCount(admin.newMembers)} ${admin.newMembers === 1 ? "person" : "people"} joined`,
    );
  }
  if (admin.activePeople > 0) {
    parts.push(
      `${formatCount(admin.activePeople)} ${admin.activePeople === 1 ? "person" : "people"} active`,
    );
  }
  if (parts.length === 0) return null;
  return parts.join(" · ");
}

function sectionBlock(
  section: WeeklyDigestSection,
  webOrigin: string,
): { html: string; text: string } {
  const filesUrl = safeHttps(
    `${webOrigin}/account/workspaces/${encodeURIComponent(section.slug)}/files`,
  );
  const title = filesUrl
    ? `<a href="${escapeHtml(filesUrl)}" style="${LINK}font-weight:600;">${escapeHtml(section.name)}</a>`
    : strong(section.name);
  const stats = statsText(section);
  const repos = bulletList(
    section.repos.map((repo) => ({
      html: `${escapeHtml(repo.name)} <span style="color:#8a8a83;">(${formatCount(repo.count)})</span>`,
      text: `${repo.name} (${formatCount(repo.count)})`,
    })),
  );
  const shots = screenshotBlock(section.screenshots);
  const pulls = bulletList(section.pulls.map(itemLine));
  const issues = bulletList(section.issues.map(itemLine));
  const pages = bulletList(
    section.pages.map((page) => ({
      html: `${escapeHtml(page.path)} <span style="color:#8a8a83;">(${formatCount(page.count)})</span>`,
      text: `${page.path} (${formatCount(page.count)})`,
    })),
  );
  const galleries = galleryText(section);
  const admin = section.admin ? adminText(section.admin) : null;

  const htmlParts = [
    `<p style="margin:0 0 8px;font-size:16px;">${title}</p>`,
    section.blurb ? `<p style="margin:0 0 12px;">${escapeHtml(section.blurb)}</p>` : "",
    stats ? `<p style="margin:0 0 12px;">${escapeHtml(stats)}</p>` : "",
    repos.html ? `${heading("Active repos")}${repos.html}` : "",
    shots.html,
    pulls.html ? `${heading("Pull requests")}${pulls.html}` : "",
    issues.html ? `${heading("Issues")}${issues.html}` : "",
    pages.html ? `${heading("Pages")}${pages.html}` : "",
    galleries ? `<p style="margin:0 0 12px;">${escapeHtml(galleries)}</p>` : "",
    admin ? `${heading("Workspace")}<p style="margin:0 0 4px;">${escapeHtml(admin)}</p>` : "",
  ];

  const textParts = [
    section.name,
    section.blurb,
    stats ?? "",
    repos.text ? `Active repos:\n${repos.text}` : "",
    shots.text,
    pulls.text ? `Pull requests:\n${pulls.text}` : "",
    issues.text ? `Issues:\n${issues.text}` : "",
    pages.text ? `Pages:\n${pages.text}` : "",
    galleries ?? "",
    admin ? `Workspace: ${admin}` : "",
    filesUrl ? filesUrl : "",
  ].filter((part) => part.length > 0);

  return { html: htmlParts.join(""), text: textParts.join("\n") };
}

function unsubscribeNote(input: WeeklyDigestEmailInput): { html: string; text: string } {
  const links: { html: string; text: string }[] = [];
  const digest = safeHttps(input.unsubscribeDigestUrl);
  const workspace = safeHttps(input.unsubscribeWorkspaceUrl);
  if (digest) {
    links.push({
      html: `<a href="${escapeHtml(digest)}" style="${LINK}">Unsubscribe from this weekly summary</a>`,
      text: `Unsubscribe from this weekly summary: ${digest}`,
    });
  }
  if (workspace) {
    links.push({
      html: `<a href="${escapeHtml(workspace)}" style="${LINK}">Unsubscribe from workspace summaries</a>`,
      text: `Unsubscribe from workspace summaries: ${workspace}`,
    });
  }
  if (links.length === 0) return { html: "", text: "" };
  return {
    html: links.map((link) => link.html).join("<br>"),
    text: links.map((link) => link.text).join("\n"),
  };
}

/** Weekly digest card. Callers skip the send when `sections` is empty. */
export function renderWeeklyDigestEmail(input: WeeklyDigestEmailInput): RenderedEmail {
  const webOrigin = (input.webOrigin || "https://uploads.sh").replace(/\/$/, "");
  const sections = input.sections;
  const first = sections[0];
  const subject =
    sections.length === 1 && first ? `Your week in ${first.name}` : "Your week on uploads.sh";
  const blocks = sections.map((section) => sectionBlock(section, webOrigin));
  const omitted =
    input.omittedWorkspaces && input.omittedWorkspaces > 0
      ? `${input.omittedWorkspaces} more ${input.omittedWorkspaces === 1 ? "workspace" : "workspaces"} had activity this week.`
      : "";
  const unsub = unsubscribeNote(input);
  const filesUrl = first
    ? safeHttps(`${webOrigin}/account/workspaces/${encodeURIComponent(first.slug)}/files`)
    : null;
  const divider = `<div style="border-top:1px solid #232327;margin:18px 0;"></div>`;
  const bodyHtml = blocks
    .map((block) => block.html)
    .join(divider)
    .concat(omitted ? `<p style="margin:16px 0 0;${META}">${escapeHtml(omitted)}</p>` : "");
  const text = [
    `Your week on uploads.sh (${input.weekLabel})`,
    "",
    blocks.map((block) => block.text).join("\n\n"),
    omitted,
    unsub.text,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");

  return renderEmailCard({
    subject,
    preheader: first?.blurb || `Activity for ${input.weekLabel}.`,
    eyebrow: "Weekly digest",
    title: "Your week",
    bodyHtml,
    text,
    cta: filesUrl ? { url: filesUrl, label: "View files →" } : undefined,
    footNoteHtml: unsub.html || undefined,
    webOrigin,
  });
}
