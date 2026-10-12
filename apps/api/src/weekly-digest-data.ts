/**
 * Read last-week activity from the tables the product already writes.
 * Member mail needs one highlight image and the busiest pull request.
 * Admin mail needs this week and the previous week, so the pulse can show
 * a change. A storage snapshot alone is not activity.
 */
import { publicAndEmbedUrls, type StorageConfig } from "@uploads/storage";
import { enforcedMaxStorageBytes } from "./budget";
import type { D1Queryable } from "./db-session";
import { fileTypeSql } from "./file-type-sql";
import { isPrState } from "./github-pr-activity";
import { isPurgedTombstone, type PurgedTombstone, type WorkspaceRecord } from "./workspace";
import {
  blankSource,
  digestWindow,
  mergeRepoCounts,
  type DigestPullSource,
  type DigestShotSource,
  type WorkspaceDigestSource,
} from "./weekly-digest";

const IMAGE_SQL = fileTypeSql("object_key", "screenshot");
const IMAGE_SQL_ALIAS = fileTypeSql("a.object_key", "screenshot");

interface MetricRow {
  workspace: string;
  metric: string;
  day: string;
  count: number;
  bytes: number;
}

interface PullRow {
  workspace_name: string;
  repo_full_name: string;
  pr_number: number;
  title: string | null;
  media_count: number;
  state: string | null;
}

interface RepoRow {
  workspace: string;
  repo: string;
  n: number;
}

interface PullCountRow {
  workspace: string;
  repo: string;
  num: number;
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

interface PullShotRow {
  workspace: string;
  repo: string;
  num: number;
  object_key: string;
}

interface UsageRow {
  workspace: string;
  bytes: number;
}

interface ActiveRow {
  workspace: string;
  n: number;
}

interface FirstUploadRow {
  workspace: string;
  name: string | null;
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
  bucket.set(key, (bucket.get(key) ?? 0) + count);
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

function pullKey(workspace: string, repo: string, num: number): string {
  return `${workspace}\0${repo.trim().toLowerCase()}\0${num}`;
}

export async function loadDigestSources(
  db: D1Queryable,
  registry: Pick<KVNamespace, "get">,
  now = new Date(),
): Promise<Map<string, WorkspaceDigestSource>> {
  const window = digestWindow(now);
  const sources = new Map<string, WorkspaceDigestSource>();

  const metrics = await all<MetricRow>(
    db,
    `SELECT workspace, metric, day, count, bytes FROM daily_metrics
     WHERE metric IN ('upload', 'delete') AND day >= ? AND workspace != ''`,
    window.prevSinceDay,
  );
  for (const row of metrics) {
    const source = sourceFor(sources, row.workspace);
    const count = Number(row.count) || 0;
    const bytes = Number(row.bytes) || 0;
    const current = row.day >= window.sinceDay;
    if (row.metric === "upload") {
      if (current) {
        source.uploads += count;
        source.bytesAdded += bytes;
      } else {
        source.prevUploads += count;
      }
    } else if (row.metric === "delete" && current) {
      source.bytesDeleted += bytes;
    }
  }

  const pulls = await all<PullRow>(
    db,
    `SELECT workspace_name, repo_full_name, pr_number, title, media_count, state
     FROM github_pr_activity
     WHERE last_media_at >= ?`,
    window.sinceIso,
  );
  const pullCounts = await all<PullCountRow>(
    db,
    `SELECT workspace, repo, num, COUNT(*) AS n FROM github_attachments
     WHERE created_at >= ? AND detached_at IS NULL AND kind = 'pull'
     GROUP BY workspace, repo, num`,
    window.sinceIso,
  );
  const pullByKey = new Map<string, DigestPullSource>();
  for (const row of pullCounts) {
    const repo = row.repo.trim().toLowerCase();
    const source = sourceFor(sources, row.workspace);
    const pull: DigestPullSource = {
      repo,
      number: Number(row.num),
      title: null,
      count: Number(row.n) || 0,
      state: null,
    };
    pullByKey.set(pullKey(row.workspace, repo, pull.number), pull);
    source.pulls.push(pull);
  }
  for (const row of pulls) {
    const repo = row.repo_full_name.trim().toLowerCase();
    const number = Number(row.pr_number);
    const source = sourceFor(sources, row.workspace_name);
    const key = pullKey(row.workspace_name, repo, number);
    let pull = pullByKey.get(key);
    if (!pull) {
      pull = {
        repo,
        number,
        title: row.title,
        count: Number(row.media_count) || 0,
        state: isPrState(row.state) ? row.state : null,
      };
      pullByKey.set(key, pull);
      source.pulls.push(pull);
    } else {
      pull.title = row.title;
      pull.state = isPrState(row.state) ? row.state : null;
    }
  }

  const attachRepos = await all<RepoRow>(
    db,
    `SELECT workspace, repo, COUNT(*) AS n FROM github_attachments
     WHERE created_at >= ? AND detached_at IS NULL
     GROUP BY workspace, repo`,
    window.sinceIso,
  );
  const prevRepos = await all<RepoRow>(
    db,
    `SELECT workspace, repo, COUNT(*) AS n FROM github_attachments
     WHERE created_at >= ? AND created_at < ? AND detached_at IS NULL
     GROUP BY workspace, repo`,
    window.prevSinceIso,
    window.sinceIso,
  );
  const currentRepos = new Map<string, Map<string, number>>();
  const previousRepos = new Map<string, Map<string, number>>();
  for (const row of attachRepos) {
    sourceFor(sources, row.workspace);
    bump(currentRepos, row.workspace, row.repo, Number(row.n) || 0);
  }
  for (const row of prevRepos) {
    sourceFor(sources, row.workspace);
    bump(previousRepos, row.workspace, row.repo, Number(row.n) || 0);
  }

  const usage = await all<UsageRow>(db, `SELECT workspace, bytes FROM workspace_usage`);
  for (const row of usage) {
    sourceFor(sources, row.workspace).storageBytes = Number(row.bytes) || 0;
  }

  const active = await all<ActiveRow>(
    db,
    `SELECT workspace, COUNT(DISTINCT user_id) AS n FROM client_activity
     WHERE last_seen_at >= ? AND user_id IS NOT NULL
     GROUP BY workspace`,
    window.sinceIso,
  );
  for (const row of active) sourceFor(sources, row.workspace).activePeople = Number(row.n) || 0;

  const newcomers = await all<ActiveRow>(
    db,
    `SELECT workspace, COUNT(DISTINCT user_id) AS n FROM client_activity
     WHERE first_seen_at >= ? AND user_id IS NOT NULL
     GROUP BY workspace`,
    window.sinceIso,
  );
  for (const row of newcomers) sourceFor(sources, row.workspace).newPeople = Number(row.n) || 0;

  const firstUploads = await all<FirstUploadRow>(
    db,
    `SELECT f.workspace AS workspace, MAX(u.name) AS name
     FROM file_metadata f
     LEFT JOIN user u ON u.id = f.meta_value
     WHERE f.meta_key = 'gh.uploader-id' AND trim(f.meta_value) != ''
     GROUP BY f.workspace, f.meta_value
     HAVING MIN(f.updated_at) >= ?`,
    window.sinceIso,
  );
  const firstByWorkspace = new Map<string, { count: number; name: string | null }>();
  for (const row of firstUploads) {
    const current = firstByWorkspace.get(row.workspace) ?? { count: 0, name: null };
    current.count += 1;
    current.name = current.count === 1 ? row.name?.trim() || null : null;
    firstByWorkspace.set(row.workspace, current);
  }
  for (const [workspace, first] of firstByWorkspace) {
    if (first.count > 0) sourceFor(sources, workspace).firstUploads = first;
  }

  for (const source of sources.values()) {
    source.repos = mergeRepoCounts(
      currentRepos.get(source.slug) ?? new Map(),
      previousRepos.get(source.slug) ?? new Map(),
    );
    source.pulls.sort(
      (a, b) => b.count - a.count || a.repo.localeCompare(b.repo) || a.number - b.number,
    );
  }

  await attachShots(db, registry, sources, window.sinceIso);
  return sources;
}

interface ShotInfo {
  at: string;
  label: string;
  rank: number;
  repo?: string;
  number?: number;
  kind?: "pull" | "issues";
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

  const pullShots = await all<PullShotRow>(
    db,
    `WITH shot AS (
       SELECT a.workspace, a.repo, a.num, a.object_key,
              ROW_NUMBER() OVER (
                PARTITION BY a.workspace, a.repo, a.num
                ORDER BY a.created_at DESC
              ) AS rn
       FROM github_attachments a
       WHERE a.created_at >= ? AND a.detached_at IS NULL AND a.kind = 'pull' AND ${IMAGE_SQL_ALIAS}
     )
     SELECT workspace, repo, num, object_key FROM shot WHERE rn = 1`,
    sinceIso,
  );

  const byWorkspace = new Map<string, Map<string, ShotInfo>>();
  const remember = (
    workspace: string,
    key: string,
    at: string,
    label: string,
    rank: number,
    link?: { repo: string; number: number; kind: "pull" | "issues" },
  ) => {
    if (!sources.has(workspace)) return;
    let files = byWorkspace.get(workspace);
    if (!files) {
      files = new Map();
      byWorkspace.set(workspace, files);
    }
    const current = files.get(key);
    if (!current || rank > current.rank || (rank === current.rank && at > current.at)) {
      files.set(key, {
        at: current && at < current.at ? current.at : at,
        label,
        rank,
        repo: link?.repo ?? current?.repo,
        number: link?.number ?? current?.number,
        kind: link?.kind ?? current?.kind,
      });
      return;
    }
    if (at > current.at) current.at = at;
    if (link) {
      current.repo = link.repo;
      current.number = link.number;
      current.kind = link.kind;
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
    const repo = values.get("gh.repo")?.trim().toLowerCase();
    const num = Number(values.get("gh.number"));
    const filename = first.object_key.split("/").pop() || first.object_key;
    const label = path || summary || (repo && num ? `${repo}#${num}` : repo) || filename;
    const rank = path ? 3 : summary ? 2 : repo ? 1 : 0;
    const at = rows.reduce((max, row) => (row.updated_at > max ? row.updated_at : max), "");
    const link =
      repo && Number.isInteger(num) && num > 0
        ? { repo, number: num, kind: "pull" as const }
        : undefined;
    remember(first.workspace, first.object_key, at, label, rank, link);
  }

  for (const row of attachRows) {
    const kind = row.kind === "issues" ? "issues" : "pull";
    const repo = row.repo.trim().toLowerCase();
    const label = `${repo}#${row.num}`;
    remember(row.workspace, row.object_key, row.created_at, label, 1, {
      repo,
      number: Number(row.num),
      kind,
    });
  }

  const records = new Map<string, WorkspaceRecord | PurgedTombstone | null>();
  for (const slug of sources.keys()) {
    records.set(slug, await registry.get<WorkspaceRecord | PurgedTombstone>(`ws:${slug}`, "json"));
  }
  for (const [slug, record] of records) {
    const source = sources.get(slug);
    if (!source || !record || isPurgedTombstone(record)) continue;
    const limit = enforcedMaxStorageBytes(record);
    if (limit) source.storageLimitBytes = limit;
  }

  for (const [workspace, files] of byWorkspace) {
    const source = sources.get(workspace);
    const record = records.get(workspace) ?? null;
    if (!source) continue;
    const shots: DigestShotSource[] = [];
    for (const [key, info] of files) {
      const urls = shotUrls(record, key);
      if (!urls) continue;
      shots.push({
        key,
        label: info.label,
        url: urls.url,
        embedUrl: urls.embedUrl,
        at: info.at,
        repo: info.repo,
        number: info.number,
        kind: info.kind,
      });
    }
    shots.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key.localeCompare(b.key)));
    source.shots = shots.slice(0, 3);
  }

  for (const row of pullShots) {
    const source = sources.get(row.workspace);
    const record = records.get(row.workspace) ?? null;
    if (!source) continue;
    const pull = source.pulls.find(
      (item) => item.repo === row.repo.trim().toLowerCase() && item.number === Number(row.num),
    );
    if (!pull) continue;
    const urls = shotUrls(record, row.object_key);
    if (!urls) continue;
    pull.shot = urls;
  }
}
