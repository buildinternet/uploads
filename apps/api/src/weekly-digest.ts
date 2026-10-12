/**
 * Weekly digest assembly. Turns the rows the API already stores (upload
 * counters, GitHub attachments, galleries, feeds, membership) into the
 * section payload `@uploads/email` renders. No I/O here.
 *
 * The short "your week" line is a template. Jev may pick which fact leads
 * and which screenshot goes first; a missing or low-confidence answer keeps
 * the deterministic order.
 */
import type { WeeklyDigestMessage, WeeklyDigestSection } from "@uploads/email";
import {
  CLASSIFIER_DECISION_MODEL,
  CLASSIFIER_MIN_CONFIDENCE,
  CLASSIFIER_TIMEOUT_MS,
  type ClassifierDecideRequest,
  type ClassifierRun,
  type ClassifierState,
} from "./classifier";

export const DIGEST_MAX_REPOS = 5;
export const DIGEST_MAX_PULLS = 5;
export const DIGEST_MAX_ISSUES = 5;
export const DIGEST_MAX_PAGES = 5;
export const DIGEST_MAX_GALLERIES = 3;
export const DIGEST_MAX_SHOTS = 3;
export const DIGEST_MAX_SECTIONS = 8;
/** Model calls per sweep. The rest of the workspaces keep the template. */
export const DIGEST_MAX_CURATIONS = 15;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LEADS = ["uploads", "repo", "pull", "page", "gallery", "members"] as const;
export type DigestLead = (typeof LEADS)[number];

export interface DigestShotSource {
  key: string;
  label: string;
  url: string;
  embedUrl: string | null;
  at: string;
}

export interface WorkspaceDigestSource {
  slug: string;
  uploads: number;
  bytesAdded: number;
  repos: { name: string; count: number }[];
  shots: DigestShotSource[];
  pulls: { repo: string; number: number; title: string | null; count: number }[];
  issues: { repo: string; number: number; count: number }[];
  pages: { path: string; count: number }[];
  galleryNames: string[];
  galleryCount: number;
  feeds: number;
  storageBytes: number;
  objects: number;
  uploadsThisMonth: number;
  newMembers: number;
  activePeople: number;
}

export interface DigestMembership {
  slug: string;
  orgName: string;
  role: string;
}

export interface DigestRecipient {
  userId: string;
  email: string;
  name: string;
  digest: boolean;
  workspaceDigest: boolean;
  memberships: DigestMembership[];
}

export interface DigestCuration {
  lead?: DigestLead;
  shotIndex?: number;
}

export function digestWindow(now = new Date()): {
  sinceIso: string;
  sinceDay: string;
  sinceUnix: number;
  weekLabel: string;
} {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return {
    sinceIso: since.toISOString(),
    sinceDay: since.toISOString().slice(0, 10),
    sinceUnix: Math.floor(since.getTime() / 1000),
    weekLabel: weekLabel(since, now),
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function weekLabel(since: Date, now: Date): string {
  const start = `${MONTHS[since.getUTCMonth()]} ${since.getUTCDate()}`;
  const endDay = String(now.getUTCDate());
  if (
    since.getUTCMonth() === now.getUTCMonth() &&
    since.getUTCFullYear() === now.getUTCFullYear()
  ) {
    return `${start}–${endDay}`;
  }
  return `${start}–${MONTHS[now.getUTCMonth()]} ${endDay}`;
}

export function hasFileActivity(source: WorkspaceDigestSource): boolean {
  return (
    source.uploads > 0 ||
    source.bytesAdded > 0 ||
    source.repos.length > 0 ||
    source.shots.length > 0 ||
    source.pulls.length > 0 ||
    source.issues.length > 0 ||
    source.pages.length > 0 ||
    source.galleryCount > 0 ||
    source.feeds > 0
  );
}

/** People who joined or showed up. A storage snapshot alone is not activity. */
export function hasAdminActivity(source: WorkspaceDigestSource): boolean {
  return source.newMembers > 0 || source.activePeople > 0;
}

function isAdminRole(role: string): boolean {
  return role === "admin" || role === "owner";
}

function githubHref(repo: string, kind: "pull" | "issues", num: number): string | undefined {
  if (!REPO_RE.test(repo) || !Number.isInteger(num) || num <= 0) return undefined;
  return `https://github.com/${repo}/${kind}/${num}`;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return `${Math.max(0, Math.round(n))} B`;
  const units = ["kB", "MB", "GB", "TB"];
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

export interface DigestFacts {
  name: string;
  uploads: number;
  bytesAdded: number;
  topRepo?: string;
  topPull?: string;
  topPage?: string;
  galleryCount: number;
  feeds: number;
  newMembers: number;
}

export function factsFor(
  source: WorkspaceDigestSource,
  name: string,
  includeAdmin: boolean,
): DigestFacts {
  return {
    name,
    uploads: source.uploads,
    bytesAdded: source.bytesAdded,
    topRepo: source.repos[0]?.name,
    topPull: source.pulls[0] ? `${source.pulls[0].repo}#${source.pulls[0].number}` : undefined,
    topPage: source.pages[0]?.path,
    galleryCount: source.galleryCount,
    feeds: source.feeds,
    newMembers: includeAdmin ? source.newMembers : 0,
  };
}

export function availableLeads(facts: DigestFacts): DigestLead[] {
  const leads: DigestLead[] = [];
  if (facts.uploads > 0 || facts.bytesAdded > 0) leads.push("uploads");
  if (facts.topRepo) leads.push("repo");
  if (facts.topPull) leads.push("pull");
  if (facts.topPage) leads.push("page");
  if (facts.galleryCount > 0 || facts.feeds > 0) leads.push("gallery");
  if (facts.newMembers > 0) leads.push("members");
  return leads;
}

/** Highest-priority fact. Used when Jev is absent or declines. */
export function defaultLead(facts: DigestFacts): DigestLead {
  return availableLeads(facts)[0] ?? "uploads";
}

function leadSentence(facts: DigestFacts, lead: DigestLead): string {
  switch (lead) {
    case "uploads": {
      const files = facts.uploads === 1 ? "1 file" : `${formatCount(facts.uploads)} files`;
      const bytes = facts.bytesAdded > 0 ? ` (${formatBytes(facts.bytesAdded)} added)` : "";
      return `${facts.name} uploaded ${files}${bytes} this week.`;
    }
    case "repo":
      return `Most of the week's files in ${facts.name} landed in ${facts.topRepo}.`;
    case "pull":
      return `${facts.topPull} picked up the most screenshots in ${facts.name}.`;
    case "page":
      return `${facts.topPage} was the page worked on most in ${facts.name}.`;
    case "gallery": {
      const parts: string[] = [];
      if (facts.galleryCount > 0) {
        parts.push(
          facts.galleryCount === 1 ? "1 gallery" : `${formatCount(facts.galleryCount)} galleries`,
        );
      }
      if (facts.feeds > 0) {
        parts.push(
          facts.feeds === 1 ? "1 change feed" : `${formatCount(facts.feeds)} change feeds`,
        );
      }
      return `${facts.name} updated ${parts.join(" and ")} this week.`;
    }
    case "members":
      return facts.newMembers === 1
        ? `1 person joined ${facts.name} this week.`
        : `${formatCount(facts.newMembers)} people joined ${facts.name} this week.`;
  }
}

export function weeklyBlurb(facts: DigestFacts, preferred?: DigestLead): string {
  const leads = availableLeads(facts);
  const lead = preferred && leads.includes(preferred) ? preferred : defaultLead(facts);
  const primary = leadSentence(facts, lead);
  const second = leads.find((item) => item !== lead);
  if (!second) return primary;
  return `${primary} ${leadSentence(facts, second)}`;
}

export function orderShots<T>(shots: T[], index: number | undefined): T[] {
  if (index === undefined || index <= 0 || index >= shots.length) return shots;
  const next = shots.slice();
  const [picked] = next.splice(index, 1);
  if (!picked) return shots;
  next.unshift(picked);
  return next;
}

function emptySource(slug: string): WorkspaceDigestSource {
  return {
    slug,
    uploads: 0,
    bytesAdded: 0,
    repos: [],
    shots: [],
    pulls: [],
    issues: [],
    pages: [],
    galleryNames: [],
    galleryCount: 0,
    feeds: 0,
    storageBytes: 0,
    objects: 0,
    uploadsThisMonth: 0,
    newMembers: 0,
    activePeople: 0,
  };
}

export function sectionFromSource(
  source: WorkspaceDigestSource,
  opts: {
    name: string;
    includeActivity: boolean;
    includeAdmin: boolean;
    curation?: DigestCuration;
  },
): WeeklyDigestSection | null {
  const showFiles = (opts.includeActivity || opts.includeAdmin) && hasFileActivity(source);
  const showPeople = opts.includeAdmin && hasAdminActivity(source);
  if (!showFiles && !showPeople) return null;

  const facts = factsFor(source, opts.name, opts.includeAdmin);
  const shots = orderShots(source.shots, opts.curation?.shotIndex).slice(0, DIGEST_MAX_SHOTS);
  const admin =
    opts.includeAdmin &&
    (showFiles || showPeople) &&
    (source.storageBytes > 0 ||
      source.objects > 0 ||
      source.uploadsThisMonth > 0 ||
      source.newMembers > 0 ||
      source.activePeople > 0)
      ? {
          storageBytes: source.storageBytes,
          objects: source.objects,
          uploadsThisMonth: source.uploadsThisMonth,
          newMembers: source.newMembers,
          activePeople: source.activePeople,
        }
      : undefined;

  return {
    slug: source.slug,
    name: opts.name,
    blurb: weeklyBlurb(facts, opts.curation?.lead),
    uploads: showFiles ? source.uploads : 0,
    bytesAdded: showFiles ? source.bytesAdded : 0,
    repos: showFiles ? source.repos.slice(0, DIGEST_MAX_REPOS) : [],
    screenshots: showFiles
      ? shots.map((shot) => ({ url: shot.url, embedUrl: shot.embedUrl, label: shot.label }))
      : [],
    pulls: showFiles
      ? source.pulls.slice(0, DIGEST_MAX_PULLS).map((pull) => ({
          label: `${pull.repo}#${pull.number}`,
          href: githubHref(pull.repo, "pull", pull.number),
          detail: pull.title ?? undefined,
        }))
      : [],
    issues: showFiles
      ? source.issues.slice(0, DIGEST_MAX_ISSUES).map((issue) => ({
          label: `${issue.repo}#${issue.number}`,
          href: githubHref(issue.repo, "issues", issue.number),
        }))
      : [],
    pages: showFiles ? source.pages.slice(0, DIGEST_MAX_PAGES) : [],
    galleries: showFiles ? source.galleryNames.slice(0, DIGEST_MAX_GALLERIES) : [],
    galleryCount: showFiles ? source.galleryCount : 0,
    feeds: showFiles ? source.feeds : 0,
    admin,
  };
}

function sectionScore(section: WeeklyDigestSection): number {
  return (
    section.uploads +
    section.pulls.length +
    section.issues.length +
    (section.admin?.newMembers ?? 0)
  );
}

/** One email per opted-in user. Quiet memberships are left out. */
export function draftForRecipient(
  recipient: DigestRecipient,
  sources: Map<string, WorkspaceDigestSource>,
  label: string,
  curation = new Map<string, DigestCuration>(),
): WeeklyDigestMessage | null {
  const email = recipient.email.trim();
  if (!email.includes("@")) return null;
  if (!recipient.digest && !recipient.workspaceDigest) return null;

  const sections: WeeklyDigestSection[] = [];
  let digestContributed = false;
  let workspaceContributed = false;

  for (const membership of recipient.memberships) {
    const source = sources.get(membership.slug);
    if (!source) continue;
    const admin = recipient.workspaceDigest && isAdminRole(membership.role);
    const includeActivity = recipient.digest;
    const section = sectionFromSource(source, {
      name: membership.orgName || membership.slug,
      includeActivity: includeActivity || admin,
      includeAdmin: admin,
      curation: curation.get(membership.slug),
    });
    if (!section) continue;
    // The member digest only covers file activity. New members alone belong
    // to the workspace digest, so they must not add its unsubscribe link.
    if (recipient.digest && hasFileActivity(source)) digestContributed = true;
    if (admin) workspaceContributed = true;
    sections.push(section);
  }

  if (sections.length === 0) return null;
  sections.sort((a, b) => sectionScore(b) - sectionScore(a) || a.name.localeCompare(b.name));
  const omittedWorkspaces = Math.max(0, sections.length - DIGEST_MAX_SECTIONS);
  const kept = sections.slice(0, DIGEST_MAX_SECTIONS);
  const unsubscribes: WeeklyDigestMessage["unsubscribes"] = [];
  if (recipient.digest && digestContributed) unsubscribes.push("digest");
  if (workspaceContributed) unsubscribes.push("workspace");
  if (unsubscribes.length === 0) unsubscribes.push(recipient.digest ? "digest" : "workspace");

  return {
    userId: recipient.userId,
    to: email,
    weekLabel: label,
    sections: kept,
    omittedWorkspaces,
    unsubscribes,
  };
}

export function slugsWorthCurating(messages: WeeklyDigestMessage[]): string[] {
  const score = new Map<string, number>();
  for (const message of messages) {
    for (const section of message.sections) {
      score.set(section.slug, Math.max(score.get(section.slug) ?? 0, section.uploads));
    }
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, DIGEST_MAX_CURATIONS)
    .map(([slug]) => slug);
}

function isLead(value: string): value is DigestLead {
  return (LEADS as readonly string[]).includes(value);
}

/** Text state only. Screenshot pixels never go to the model. */
export function buildDigestDecideRequest(
  source: WorkspaceDigestSource,
  name: string,
): ClassifierDecideRequest | null {
  const facts = factsFor(source, name, true);
  const leads = availableLeads(facts);
  const shots = source.shots.slice(0, DIGEST_MAX_SHOTS);
  if (leads.length < 2 && shots.length < 2) return null;

  const criteria: Record<string, string> = {};
  for (const lead of leads) criteria[lead] = leadSentence(facts, lead);
  const questions: ClassifierDecideRequest["questions"] = {};
  if (leads.length >= 2) {
    questions.lead = {
      type: "choice",
      instructions:
        "Which fact should open a two-sentence weekly summary? Prefer a specific repo, pull request, or page over a raw upload count when both are present.",
      criteria,
    };
  }
  if (shots.length >= 2) {
    const shotCriteria: Record<string, string> = {};
    shots.forEach((shot, index) => {
      shotCriteria[`s${index}`] = shot.label.slice(0, 140);
    });
    questions.shot = {
      type: "choice",
      instructions: "Which screenshot label best represents this workspace's week?",
      criteria: shotCriteria,
    };
  }

  const excerpt = [
    `Workspace ${name}.`,
    facts.uploads > 0 ? `${facts.uploads} files, ${facts.bytesAdded} bytes added.` : "",
    facts.topRepo ? `Top repo ${facts.topRepo}.` : "",
    facts.topPull ? `Top pull ${facts.topPull}.` : "",
    facts.topPage ? `Top page ${facts.topPage}.` : "",
    facts.galleryCount > 0 ? `${facts.galleryCount} galleries.` : "",
    facts.newMembers > 0 ? `${facts.newMembers} new members.` : "",
    shots.length > 0 ? `Screenshots: ${shots.map((shot) => shot.label).join("; ")}.` : "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");

  const state: ClassifierState = {
    filename: "weekly-digest",
    content_type: "text/plain",
    byte_size: excerpt.length,
    excerpt,
    summary: excerpt.slice(0, 140),
    note: "Counts are from the product database. Choose among the questions. Do not invent activity.",
  };

  return {
    stage: "decide",
    model: CLASSIFIER_DECISION_MODEL,
    state,
    questions,
  };
}

function answerChoice(result: unknown, field: string, allow: Set<string>): string | undefined {
  const answers = findAnswers(result);
  if (!answers) return undefined;
  const answer = answers[field];
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return undefined;
  const choice = (answer as { choice?: unknown; confidence?: unknown }).choice;
  const confidence = (answer as { confidence?: unknown }).confidence;
  if (typeof choice !== "string" || typeof confidence !== "number") return undefined;
  if (!Number.isFinite(confidence) || confidence < CLASSIFIER_MIN_CONFIDENCE) return undefined;
  const normalized = choice.trim().toLowerCase();
  if (!allow.has(normalized)) return undefined;
  return normalized;
}

function findAnswers(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  if (record.answers && typeof record.answers === "object" && !Array.isArray(record.answers)) {
    return record.answers as Record<string, unknown>;
  }
  for (const key of ["response", "result"]) {
    const inner = record[key];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      const nested = (inner as { answers?: unknown }).answers;
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        return nested as Record<string, unknown>;
      }
    }
  }
  return null;
}

export function curationFromModel(
  source: WorkspaceDigestSource,
  name: string,
  result: unknown,
): DigestCuration {
  const facts = factsFor(source, name, true);
  const leadChoice = answerChoice(result, "lead", new Set(availableLeads(facts)));
  const shotChoice = answerChoice(
    result,
    "shot",
    new Set(source.shots.slice(0, DIGEST_MAX_SHOTS).map((_, index) => `s${index}`)),
  );
  const shotIndex = shotChoice ? Number(shotChoice.slice(1)) : undefined;
  return {
    lead: leadChoice && isLead(leadChoice) ? leadChoice : undefined,
    shotIndex: shotIndex !== undefined && Number.isInteger(shotIndex) ? shotIndex : undefined,
  };
}

export async function curateWorkspace(
  source: WorkspaceDigestSource,
  name: string,
  run: ClassifierRun,
  timeoutMs = CLASSIFIER_TIMEOUT_MS,
): Promise<DigestCuration> {
  const request = buildDigestDecideRequest(source, name);
  if (!request) return {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      run(request),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("digest curation timed out")), timeoutMs);
      }),
    ]);
    return curationFromModel(source, name, result);
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "digest_curation_failed",
        workspace: source.slug,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return {};
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Merge counted maps, keeping the larger signal so attachments and PR events are not summed. */
export function mergeCounts(groups: Array<Map<string, number>>): { name: string; count: number }[] {
  const names = new Set<string>();
  for (const group of groups) for (const name of group.keys()) names.add(name);
  return [...names]
    .map((name) => ({
      name,
      count: Math.max(...groups.map((group) => group.get(name) ?? 0)),
    }))
    .filter((row) => row.count > 0 && row.name.length > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function blankSource(slug: string): WorkspaceDigestSource {
  return emptySource(slug);
}
