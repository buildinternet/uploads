/**
 * Read last-week activity from the tables the product already writes.
 * One pass over the counters, then a bounded look at tagged images so the
 * email can show a few thumbnails. Storage totals are a snapshot; they do
 * not by themselves count as activity (see weekly-digest.ts).
 */
import { publicAndEmbedUrls, type StorageConfig } from "@uploads/storage";
import type { D1Queryable } from "./db-session";
import { fileTypeSql } from "./file-type-sql";
import { usagePeriodStart } from "./usage";
import { isPurgedTombstone, type PurgedTombstone, type WorkspaceRecord } from "./workspace";
import {
  blankSource,
  digestWindow,
  mergeCounts,
  type DigestShotSource,
  type WorkspaceDigestSource,
} from "./weekly-digest";

const IMAGE_SQL = fileTypeSql("object_key", "screenshot");

interface CountRow {
  workspace: string;
  count: number;
  bytes: number;
}

interface NameRow {
  workspace: string;
  title: string;
}

interface FeedRow {
  workspace: string;
  n: number;
}

interface PullRow {
  workspace_name: string;
  repo_full_name: string;
  pr_number: number;
  title: string | null;
  media_count: number;
}

interface RepoRow {
  workspace: string;
  repo: string;
  n: number;
}

interface IssueRow {
  workspace: string;
  repo: string;
  num: number;
  n: number;
}

interface PageRow {
  workspace: string;
  path: string;
  n: number;
}

interface ShotMetaRow {
  workspace: string;
  object_key: string;
  meta_key: string;
  meta_value: string;
  updated_at: string;
}

interface AttachShotRow {
  workspace: string;
  object_key: string;
  repo: string;
  kind: string;
  num: number;
  created_at: string;
}

interface UsageRow {
  workspace: string;
  bytes: number;
  objects: number;
  uploads_in_period: number;
  period_start: string;
}

interface MemberRow {
  slug: string;
  n: number;
}

interface ActiveRow {
  workspace: string;
  n: number;
}

async function all<T>(db: D1Queryable, sql: string, ...binds: unknown[]): Promise<T[]> {
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<T>();
  return results ?? [];
}

function bump(
  map: Map<string, Map<string, number>>,
  workspace: string,
  name: string,
  count: number,
): void {
  const key = name.trim().toLowerCase();
  if (!key) return;
  let bucket = map.get(workspace);
  if (!bucket) {
    bucket = new Map();
    map.set(workspace, bucket);
  }
  bucket.set(key, Math.max(bucket.get(key) ?? 0, count));
}

function sourceFor(map: Map<string, WorkspaceDigestSource>, slug: string): WorkspaceDigestSource {
  let source = map.get(slug);
  if (!source) {
    source = blankSource(slug);
    map.set(slug, source);
  }
  return source;
}

function shotUrls(
  record: WorkspaceRecord | PurgedTombstone | null,
  key: string,
): { url: string; embedUrl: string | null } | null {
  if (!record || isPurgedTombstone(record) || record.deletedAt) return null;
  if (!record.publicBaseUrl) return null;
  const config: StorageConfig = {
    provider: "r2",
    bucket: record.bucket,
    publicBaseUrl: record.publicBaseUrl,
    prefix: record.prefix,
  };
  const urls = publicAndEmbedUrls(config, key);
  if (!urls.url || !urls.url.startsWith("https://")) return null;
  return { url: urls.url, embedUrl: urls.embedUrl };
}

export async function loadDigestSources(
  db: D1Queryable,
  registry: Pick<KVNamespace, "get">,
  now = new Date(),
): Promise<Map<string, WorkspaceDigestSource>> {
  const window = digestWindow(now);
  const sources = new Map<string, WorkspaceDigestSource>();

  const uploads = await all<CountRow>(
    db,
    `SELECT workspace, SUM(count) AS count, SUM(bytes) AS bytes
     FROM daily_metrics
     WHERE metric = 'upload' AND day >= ? AND workspace != ''
     GROUP BY workspace`,
    window.sinceDay,
  );
  for (const row of uploads) {
    const source = sourceFor(sources, row.workspace);
    source.uploads = Number(row.count) || 0;
    source.bytesAdded = Number(row.bytes) || 0;
  }

  const galleries = await all<NameRow>(
    db,
    `SELECT workspace, title FROM galleries
     WHERE deleted_at IS NULL AND (created_at >= ? OR updated_at >= ?)
     ORDER BY updated_at DESC`,
    window.sinceIso,
    window.sinceIso,
  );
  const galleryNames = new Map<string, string[]>();
  for (const row of galleries) {
    const list = galleryNames.get(row.workspace) ?? [];
    if (!list.includes(row.title)) list.push(row.title);
    galleryNames.set(row.workspace, list);
  }
  for (const [workspace, names] of galleryNames) {
    const source = sourceFor(sources, workspace);
    source.galleryCount = names.length;
    source.galleryNames = names;
  }

  const feeds = await all<FeedRow>(
    db,
    `SELECT workspace, COUNT(*) AS n FROM feeds
     WHERE deleted_at IS NULL AND (created_at >= ? OR updated_at >= ?)
     GROUP BY workspace`,
    window.sinceIso,
    window.sinceIso,
  );
  for (const row of feeds) sourceFor(sources, row.workspace).feeds = Number(row.n) || 0;

  const pulls = await all<PullRow>(
    db,
    `SELECT workspace_name, repo_full_name, pr_number, title, media_count
     FROM github_pr_activity
     WHERE last_media_at >= ?
     ORDER BY media_count DESC, last_media_at DESC`,
    window.sinceIso,
  );
  const pullCounts = new Map<string, Map<string, number>>();
  for (const row of pulls) {
    const source = sourceFor(sources, row.workspace_name);
    source.pulls.push({
      repo: row.repo_full_name,
      number: Number(row.pr_number),
      title: row.title,
      count: Number(row.media_count) || 0,
    });
    bump(pullCounts, row.workspace_name, row.repo_full_name, Number(row.media_count) || 0);
  }

  const attachRepos = await all<RepoRow>(
    db,
    `SELECT workspace, repo, COUNT(*) AS n FROM github_attachments
     WHERE created_at >= ? AND detached_at IS NULL
     GROUP BY workspace, repo`,
    window.sinceIso,
  );
  const attachCounts = new Map<string, Map<string, number>>();
  for (const row of attachRepos) {
    sourceFor(sources, row.workspace);
    bump(attachCounts, row.workspace, row.repo, Number(row.n) || 0);
  }

  const issues = await all<IssueRow>(
    db,
    `SELECT workspace, repo, num, COUNT(*) AS n FROM github_attachments
     WHERE created_at >= ? AND detached_at IS NULL AND kind = 'issues'
     GROUP BY workspace, repo, num
     ORDER BY n DESC`,
    window.sinceIso,
  );
  for (const row of issues) {
    sourceFor(sources, row.workspace).issues.push({
      repo: row.repo,
      number: Number(row.num),
      count: Number(row.n) || 0,
    });
  }

  const pages = await all<PageRow>(
    db,
    `SELECT workspace, meta_value AS path, COUNT(DISTINCT object_key) AS n
     FROM file_metadata
     WHERE meta_key = 'path' AND updated_at >= ? AND trim(meta_value) != ''
     GROUP BY workspace, meta_value
     ORDER BY n DESC`,
    window.sinceIso,
  );
  for (const row of pages) {
    sourceFor(sources, row.workspace).pages.push({ path: row.path, count: Number(row.n) || 0 });
  }

  const period = usagePeriodStart(now);
  const usage = await all<UsageRow>(
    db,
    `SELECT workspace, bytes, objects, uploads_in_period, period_start FROM workspace_usage`,
  );
  for (const row of usage) {
    if (!sources.has(row.workspace)) continue;
    const source = sourceFor(sources, row.workspace);
    source.storageBytes = Number(row.bytes) || 0;
    source.objects = Number(row.objects) || 0;
    source.uploadsThisMonth = row.period_start === period ? Number(row.uploads_in_period) || 0 : 0;
  }

  const members = await all<MemberRow>(
    db,
    `SELECT o.slug AS slug, COUNT(*) AS n
     FROM member m
     INNER JOIN organization o ON o.id = m.organization_id
     WHERE m.created_at >= ?
     GROUP BY o.slug`,
    window.sinceUnix,
  );
  for (const row of members) sourceFor(sources, row.slug).newMembers = Number(row.n) || 0;

  const active = await all<ActiveRow>(
    db,
    `SELECT workspace, COUNT(DISTINCT user_id) AS n FROM client_activity
     WHERE last_seen_at >= ? AND user_id IS NOT NULL
     GROUP BY workspace`,
    window.sinceIso,
  );
  for (const row of active) sourceFor(sources, row.workspace).activePeople = Number(row.n) || 0;

  for (const source of sources.values()) {
    const repos = mergeCounts([
      pullCounts.get(source.slug) ?? new Map(),
      attachCounts.get(source.slug) ?? new Map(),
    ]);
    source.repos = repos;
    source.pulls.sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo));
    source.issues.sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo));
    source.pages.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  }

  await attachShots(db, registry, sources, window.sinceIso);
  return sources;
}

async function attachShots(
  db: D1Queryable,
  registry: Pick<KVNamespace, "get">,
  sources: Map<string, WorkspaceDigestSource>,
  sinceIso: string,
): Promise<void> {
  const metaRows = await all<ShotMetaRow>(
    db,
    `WITH keyed AS (
       SELECT workspace, object_key, MAX(updated_at) AS updated_at
       FROM file_metadata
       WHERE updated_at >= ?
         AND meta_key IN ('path', 'gh.repo', 'gh.number', 'ai.summary')
         AND ${IMAGE_SQL}
       GROUP BY workspace, object_key
     ),
     ranked AS (
       SELECT workspace, object_key, updated_at,
              ROW_NUMBER() OVER (PARTITION BY workspace ORDER BY updated_at DESC) AS rn
       FROM keyed
     )
     SELECT f.workspace, f.object_key, f.meta_key, f.meta_value, f.updated_at
     FROM file_metadata f
     INNER JOIN ranked r ON r.workspace = f.workspace AND r.object_key = f.object_key
     WHERE r.rn <= 3
       AND f.meta_key IN ('path', 'gh.repo', 'gh.number', 'ai.summary')`,
    sinceIso,
  );

  const attachRows = await all<AttachShotRow>(
    db,
    `WITH ranked AS (
       SELECT workspace, object_key, repo, kind, num, created_at,
              ROW_NUMBER() OVER (PARTITION BY workspace ORDER BY created_at DESC) AS rn
       FROM github_attachments
       WHERE created_at >= ? AND detached_at IS NULL AND ${IMAGE_SQL}
     )
     SELECT workspace, object_key, repo, kind, num, created_at
     FROM ranked WHERE rn <= 3`,
    sinceIso,
  );

  const byWorkspace = new Map<string, Map<string, { at: string; label: string; rank: number }>>();
  // Higher rank wins: a page path is a better caption than a filename, even
  // when the filename's row is newer.
  const remember = (workspace: string, key: string, at: string, label: string, rank: number) => {
    if (!sources.has(workspace)) return;
    let files = byWorkspace.get(workspace);
    if (!files) {
      files = new Map();
      byWorkspace.set(workspace, files);
    }
    const current = files.get(key);
    if (!current || rank > current.rank || (rank === current.rank && at > current.at)) {
      files.set(key, { at: current && at < current.at ? current.at : at, label, rank });
    } else if (at > current.at) {
      current.at = at;
    }
  };

  const grouped = new Map<string, ShotMetaRow[]>();
  for (const row of metaRows) {
    const list = grouped.get(`${row.workspace}\0${row.object_key}`) ?? [];
    list.push(row);
    grouped.set(`${row.workspace}\0${row.object_key}`, list);
  }
  for (const rows of grouped.values()) {
    const first = rows[0];
    if (!first) continue;
    const values = new Map(rows.map((row) => [row.meta_key, row.meta_value]));
    const path = values.get("path")?.trim();
    const summary = values.get("ai.summary")?.trim();
    const repo = values.get("gh.repo")?.trim();
    const num = values.get("gh.number")?.trim();
    const filename = first.object_key.split("/").pop() || first.object_key;
    const label = path || summary || (repo && num ? `${repo}#${num}` : repo) || filename;
    const rank = path ? 3 : summary ? 2 : repo ? 1 : 0;
    const at = rows.reduce((max, row) => (row.updated_at > max ? row.updated_at : max), "");
    remember(first.workspace, first.object_key, at, label, rank);
  }

  for (const row of attachRows) {
    const named = row.kind === "issues" || row.kind === "pull";
    const label = named
      ? `${row.repo}#${row.num}`
      : row.object_key.split("/").pop() || row.object_key;
    remember(row.workspace, row.object_key, row.created_at, label, named ? 1 : 0);
  }

  const records = new Map<string, WorkspaceRecord | PurgedTombstone | null>();
  for (const workspace of byWorkspace.keys()) {
    records.set(
      workspace,
      await registry.get<WorkspaceRecord | PurgedTombstone>(`ws:${workspace}`, "json"),
    );
  }

  for (const [workspace, files] of byWorkspace) {
    const source = sources.get(workspace);
    const record = records.get(workspace) ?? null;
    if (!source) continue;
    const shots: DigestShotSource[] = [];
    for (const [key, info] of files) {
      const urls = shotUrls(record, key);
      if (!urls) continue;
      shots.push({ key, label: info.label, url: urls.url, embedUrl: urls.embedUrl, at: info.at });
    }
    shots.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key.localeCompare(b.key)));
    source.shots = shots.slice(0, 3);
  }
}
