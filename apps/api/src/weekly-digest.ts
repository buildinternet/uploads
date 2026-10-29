/**
 * Weekly digest assembly. Turns the rows the API already stores into the
 * short payload `@uploads/email` renders. No I/O here.
 *
 * A member digest is one highlight, the busiest pull request, and a stat
 * line. An admin digest is three headline numbers, a few plain sentences,
 * and a storage footnote when the plan is nearly full. Each workspace is its
 * own email. Jev may choose the highlight from screenshot captions, through
 * the Workers AI binding (`typesafe/jev`). File classification uses
 * OpenRouter instead. A missing or low-confidence answer keeps the newest
 * image.
 */
import type {
  WeeklyDigestHighlight,
  WeeklyDigestMessage,
  WeeklyDigestNote,
  WeeklyDigestPulse,
  WeeklyDigestPulseBlock,
  WeeklyDigestTopPull,
  WeeklyDigestUser,
} from "@uploads/email";
import {
  CLASSIFIER_DECISION_MODEL,
  CLASSIFIER_MIN_CONFIDENCE,
  CLASSIFIER_TIMEOUT_MS,
  type ClassifierDecideRequest,
  type ClassifierRun,
  type ClassifierState,
} from "./classifier";

/** Screenshot candidates Jev may choose among. The mail shows one. */
export const DIGEST_MAX_SHOTS = 3;
/** Plain activity lines in one admin pulse. The storage footnote is separate. */
export const DIGEST_MAX_NOTES = 3;
/** Model calls per sweep. The rest of the workspaces keep the newest image. */
export const DIGEST_MAX_CURATIONS = 15;
/** A repo is "suddenly busy" once it clears this many files in the week. */
export const DIGEST_BUSY_REPO_MIN = 3;
/** Storage at or above this fraction of the plan cap is worth a callout. */
export const DIGEST_STORAGE_PRESSURE = 0.8;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface DigestShotSource {
  key: string;
  label: string;
  url: string;
  embedUrl: string | null;
  at: string;
  repo?: string;
  number?: number;
  kind?: "pull" | "issues";
}

export interface DigestPullSource {
  repo: string;
  number: number;
  title: string | null;
  count: number;
  state: "open" | "closed" | "merged" | null;
  shot?: { url: string; embedUrl: string | null };
}

export interface DigestRepoSource {
  name: string;
  count: number;
  prev: number;
}

export interface WorkspaceDigestSource {
  slug: string;
  uploads: number;
  prevUploads: number;
  bytesAdded: number;
  bytesDeleted: number;
  repos: DigestRepoSource[];
  shots: DigestShotSource[];
  pulls: DigestPullSource[];
  storageBytes: number;
  storageLimitBytes?: number;
  activePeople: number;
  newPeople: number;
  firstUploads?: { count: number; name: string | null };
}

export interface DigestMembership {
  slug: string;
  orgName: string;
  role: string;
  /** Member digest for this workspace. */
  digest: boolean;
  /** Admin pulse for this workspace. Ignored unless the role is admin or owner. */
  workspaceDigest: boolean;
}

export interface DigestRecipient {
  userId: string;
  email: string;
  name: string;
  memberships: DigestMembership[];
}

export interface DigestCuration {
  shotIndex?: number;
}

export function digestWindow(now = new Date()): {
  sinceIso: string;
  sinceDay: string;
  sinceUnix: number;
  prevSinceIso: string;
  prevSinceDay: string;
  weekLabel: string;
} {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const prev = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  return {
    sinceIso: since.toISOString(),
    sinceDay: since.toISOString().slice(0, 10),
    sinceUnix: Math.floor(since.getTime() / 1000),
    prevSinceIso: prev.toISOString(),
    prevSinceDay: prev.toISOString().slice(0, 10),
    // The query window ends when the cron runs. The label is the seven
    // calendar dates that start that window (Monday through Sunday), so a
    // Monday run does not print both Mondays.
    weekLabel: weekLabel(since),
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function weekLabel(since: Date): string {
  const end = new Date(since.getTime() + 6 * 24 * 60 * 60 * 1000);
  const start = `${MONTHS[since.getUTCMonth()]} ${since.getUTCDate()}`;
  const endDay = String(end.getUTCDate());
  if (
    since.getUTCMonth() === end.getUTCMonth() &&
    since.getUTCFullYear() === end.getUTCFullYear()
  ) {
    return `${start}–${endDay}`;
  }
  return `${start}–${MONTHS[end.getUTCMonth()]} ${endDay}`;
}

export function hasFileActivity(source: WorkspaceDigestSource): boolean {
  return (
    source.uploads > 0 ||
    source.bytesAdded > 0 ||
    source.repos.some((repo) => repo.count > 0) ||
    source.shots.length > 0 ||
    source.pulls.length > 0
  );
}

function isAdminRole(role: string): boolean {
  return role.split(",").some((part) => {
    const trimmed = part.trim();
    return trimmed === "admin" || trimmed === "owner";
  });
}

function githubHref(repo: string, kind: "pull" | "issues", num: number): string | undefined {
  if (!REPO_RE.test(repo) || !Number.isInteger(num) || num <= 0) return undefined;
  return `https://github.com/${repo}/${kind}/${num}`;
}

/** Newest first, capped. Jev's `s0` is this list's first item. */
export function candidateShots(source: WorkspaceDigestSource): DigestShotSource[] {
  return source.shots
    .slice()
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key.localeCompare(b.key)))
    .slice(0, DIGEST_MAX_SHOTS);
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
    prevUploads: 0,
    bytesAdded: 0,
    bytesDeleted: 0,
    repos: [],
    shots: [],
    pulls: [],
    storageBytes: 0,
    activePeople: 0,
    newPeople: 0,
  };
}

/** The repo whose week jumped the most, once it clears the busy threshold. */
export function notableRepo(repos: DigestRepoSource[]): DigestRepoSource | null {
  const hits = repos.filter(
    (repo) =>
      repo.count >= DIGEST_BUSY_REPO_MIN && repo.count > repo.prev && repo.count >= repo.prev * 2,
  );
  hits.sort(
    (a, b) =>
      b.count - b.prev - (a.count - a.prev) || b.count - a.count || a.name.localeCompare(b.name),
  );
  return hits[0] ?? null;
}

/** Whole-number percent when storage is near the plan cap, otherwise null. */
export function storagePressurePercent(bytes: number, limit: number | undefined): number | null {
  if (!limit || limit <= 0 || bytes <= 0) return null;
  if (bytes / limit < DIGEST_STORAGE_PRESSURE) return null;
  return Math.min(100, Math.round((bytes / limit) * 100));
}

export function hasAdminPulse(source: WorkspaceDigestSource): boolean {
  if (source.uploads > 0 || source.prevUploads > 0) return true;
  if (source.activePeople > 0 || source.newPeople > 0) return true;
  if (source.bytesAdded > 0 || source.bytesDeleted > 0) return true;
  if ((source.firstUploads?.count ?? 0) > 0) return true;
  if (notableRepo(source.repos)) return true;
  if (storagePressurePercent(source.storageBytes, source.storageLimitBytes) !== null) return true;
  return false;
}

function billingPath(slug: string): string {
  return `/account/workspaces/${encodeURIComponent(slug)}/billing`;
}

function highlightFrom(shot: DigestShotSource): WeeklyDigestHighlight {
  const kind = shot.kind === "issues" ? "issues" : "pull";
  const href = shot.repo && shot.number ? githubHref(shot.repo, kind, shot.number) : undefined;
  const hrefLabel = shot.repo && shot.number ? `${shot.repo}#${shot.number}` : undefined;
  return {
    url: shot.url,
    embedUrl: shot.embedUrl,
    caption: shot.label,
    href,
    hrefLabel,
  };
}

function topPullFrom(pull: DigestPullSource): WeeklyDigestTopPull {
  return {
    title: pull.title?.trim() || `${pull.repo}#${pull.number}`,
    repo: pull.repo,
    number: pull.number,
    href: githubHref(pull.repo, "pull", pull.number),
    state: pull.state ?? undefined,
    thumbnailUrl: pull.shot?.url,
    thumbnailEmbedUrl: pull.shot?.embedUrl,
  };
}

function activityNotes(source: WorkspaceDigestSource): WeeklyDigestNote[] {
  const notes: WeeklyDigestNote[] = [];
  const repo = notableRepo(source.repos);
  if (repo) {
    notes.push({
      text:
        repo.prev > 0
          ? `${repo.name} got busy — ${repo.count} files, up from ${repo.prev}`
          : `${repo.name} got busy — ${repo.count} files this week`,
    });
  }
  const first = source.firstUploads;
  if (first && first.count > 0) {
    const text =
      first.count === 1
        ? first.name
          ? `${first.name}'s first upload`
          : "A teammate's first upload"
        : `${first.count} people's first uploads`;
    notes.push({ text });
  }
  return notes.slice(0, DIGEST_MAX_NOTES);
}

function storageNoteFor(source: WorkspaceDigestSource, name: string): WeeklyDigestNote | undefined {
  const percent = storagePressurePercent(source.storageBytes, source.storageLimitBytes);
  if (percent === null) return undefined;
  const who = name.trim() || source.slug;
  return {
    text: `${who} is using ${percent}% of its storage. Upgrade or connect a bucket when you're ready`,
    href: billingPath(source.slug),
  };
}

function pulseFrom(source: WorkspaceDigestSource, name: string): WeeklyDigestPulse {
  return {
    uploads: source.uploads,
    uploadsDelta: source.uploads - source.prevUploads,
    activeMembers: source.activePeople,
    activeMembersNew: source.newPeople,
    storageBytes: source.storageBytes,
    storageDeltaBytes: source.bytesAdded - source.bytesDeleted,
    notes: activityNotes(source),
    storageNote: storageNoteFor(source, name),
  };
}

function buildUserForWorkspace(
  membership: DigestMembership,
  source: WorkspaceDigestSource,
  curation: DigestCuration | undefined,
): WeeklyDigestUser | undefined {
  if (!hasFileActivity(source)) return undefined;
  const repoNames = new Set<string>();
  for (const repo of source.repos) {
    if (repo.count > 0) repoNames.add(repo.name);
  }
  const shot = orderShots(candidateShots(source), curation?.shotIndex)[0];
  const pull = source.pulls.find((item) => item.count > 0);
  return {
    workspaceName: membership.orgName || membership.slug,
    workspaceSlug: membership.slug,
    highlight: shot ? highlightFrom(shot) : undefined,
    topPull: pull ? topPullFrom(pull) : undefined,
    uploads: source.uploads,
    repos: repoNames.size,
  };
}

function buildPulseForWorkspace(
  membership: DigestMembership,
  source: WorkspaceDigestSource,
): WeeklyDigestPulseBlock | undefined {
  if (!isAdminRole(membership.role) || !hasAdminPulse(source)) return undefined;
  return {
    slug: source.slug,
    name: membership.orgName || membership.slug,
    pulse: pulseFrom(source, membership.orgName || membership.slug),
  };
}

function draftScore(message: WeeklyDigestMessage): number {
  return message.user?.uploads ?? message.pulses[0]?.pulse.uploads ?? 0;
}

function draftName(message: WeeklyDigestMessage): string {
  return message.user?.workspaceName || message.pulses[0]?.name || message.pulses[0]?.slug || "";
}

/**
 * One email per workspace that has something to say. A quiet workspace is
 * absent. Member and admin content for the same workspace stay in that one
 * email.
 */
export function draftsForRecipient(
  recipient: DigestRecipient,
  sources: Map<string, WorkspaceDigestSource>,
  label: string,
  curation = new Map<string, DigestCuration>(),
): WeeklyDigestMessage[] {
  const email = recipient.email.trim();
  if (!email.includes("@")) return [];
  if (
    !recipient.memberships.some((membership) => membership.digest || membership.workspaceDigest)
  ) {
    return [];
  }

  const seen = new Set<string>();
  const drafts: WeeklyDigestMessage[] = [];
  for (const membership of recipient.memberships) {
    if (seen.has(membership.slug)) continue;
    seen.add(membership.slug);
    const source = sources.get(membership.slug);
    if (!source) continue;
    const user = membership.digest
      ? buildUserForWorkspace(membership, source, curation.get(membership.slug))
      : undefined;
    const pulse = membership.workspaceDigest
      ? buildPulseForWorkspace(membership, source)
      : undefined;
    if (!user && !pulse) continue;
    const unsubscribes: WeeklyDigestMessage["unsubscribes"] = [];
    if (user) unsubscribes.push("digest");
    if (pulse) unsubscribes.push("workspace");
    drafts.push({
      userId: recipient.userId,
      to: email,
      weekLabel: label,
      user,
      pulses: pulse ? [pulse] : [],
      unsubscribes,
    });
  }
  drafts.sort((a, b) => draftScore(b) - draftScore(a) || draftName(a).localeCompare(draftName(b)));
  return drafts;
}

export function slugsWorthCurating(
  recipients: DigestRecipient[],
  sources: Map<string, WorkspaceDigestSource>,
): string[] {
  const score = new Map<string, number>();
  for (const recipient of recipients) {
    for (const membership of recipient.memberships) {
      if (!membership.digest) continue;
      const source = sources.get(membership.slug);
      if (!source || source.shots.length < 2) continue;
      score.set(membership.slug, source.uploads);
    }
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, DIGEST_MAX_CURATIONS)
    .map(([slug]) => slug);
}

/** Text labels only. Screenshot pixels and file URLs never go to the model. */
export function buildDigestDecideRequest(
  source: WorkspaceDigestSource,
): ClassifierDecideRequest | null {
  const shots = candidateShots(source);
  if (shots.length < 2) return null;
  const criteria: Record<string, string> = {};
  shots.forEach((shot, index) => {
    criteria[`s${index}`] = shot.label.slice(0, 140);
  });
  const excerpt = `Screenshots: ${shots.map((shot) => shot.label).join("; ")}.`;
  const state: ClassifierState = {
    filename: "weekly-digest",
    content_type: "text/plain",
    byte_size: excerpt.length,
    excerpt,
    summary: excerpt.slice(0, 140),
    note: "Captions are from file metadata. Choose one. Do not invent a file.",
  };
  return {
    stage: "decide",
    model: CLASSIFIER_DECISION_MODEL,
    state,
    questions: {
      shot: {
        type: "choice",
        instructions: "Which caption is the single best highlight of this workspace's week?",
        criteria,
      },
    },
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

export function curationFromModel(source: WorkspaceDigestSource, result: unknown): DigestCuration {
  const shotChoice = answerChoice(
    result,
    "shot",
    new Set(candidateShots(source).map((_, index) => `s${index}`)),
  );
  const shotIndex = shotChoice ? Number(shotChoice.slice(1)) : undefined;
  return {
    shotIndex: shotIndex !== undefined && Number.isInteger(shotIndex) ? shotIndex : undefined,
  };
}

export async function curateWorkspace(
  source: WorkspaceDigestSource,
  run: ClassifierRun,
  timeoutMs = CLASSIFIER_TIMEOUT_MS,
): Promise<DigestCuration> {
  const request = buildDigestDecideRequest(source);
  if (!request) return {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      run(request),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("digest curation timed out")), timeoutMs);
      }),
    ]);
    return curationFromModel(source, result);
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

/** Merge counted maps. `prev` is the previous week's count for the same name. */
export function mergeRepoCounts(
  current: Map<string, number>,
  previous: Map<string, number>,
): DigestRepoSource[] {
  const names = new Set<string>([...current.keys(), ...previous.keys()]);
  return [...names]
    .map((name) => ({
      name,
      count: current.get(name) ?? 0,
      prev: previous.get(name) ?? 0,
    }))
    .filter((row) => (row.count > 0 || row.prev > 0) && row.name.length > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function blankSource(slug: string): WorkspaceDigestSource {
  return emptySource(slug);
}
