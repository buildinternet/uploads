#!/usr/bin/env node
/**
 * Summarizes the attachment-index shadow lines (#934 phase 2) from Workers
 * Logs: match rate, how many syncs had real attachments, and the most
 * common `missing` / `extra` keys, over the last N hours.
 *
 *   CLOUDFLARE_API_TOKEN=… node scripts/attachment-index-shadow-report.mjs [--hours 24] [--json]
 *
 * The token needs Workers Observability read on the account. Account id
 * defaults to the production account; override with CLOUDFLARE_ACCOUNT_ID.
 *
 * Shadow lines carry no `message` field, so they are matched on the parsed
 * `component` / `event` fields — a message-text search finds nothing.
 *
 * Totals come from `calculations` counts, never from listing events: an
 * events query returns one page (50 rows unless `limit` is set at the top
 * level, not inside `parameters`), and over a busy window the backend
 * samples the rows it returns. Counts are extrapolated from that sample, so
 * they print with "≈" when the backend reports a sample interval above 1.
 * Mismatched lines are rare, so they are fetched as events (filtered on
 * `missingCount > 0` / `extraCount > 0`) and paged to the end.
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const hours = Number(flag("--hours", "24"));
const asJson = args.includes("--json");
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "b082600d280d44fd5da3501bc1bffe2f";
if (!token) throw new Error("missing CLOUDFLARE_API_TOKEN");
if (!Number.isFinite(hours) || hours <= 0) throw new Error("--hours must be a positive number");

const PAGE = 2000;
const now = Date.now();
const timeframe = { from: now - hours * 3_600_000, to: now };
const service = { key: "$metadata.service", operation: "eq", value: "uploads-api", type: "string" };
const shadowFilters = [
  service,
  { key: "component", operation: "eq", value: "attachment-index", type: "string" },
  { key: "event", operation: "eq", value: "shadow", type: "string" },
];
const gt0 = (key) => ({ key, operation: "gt", value: 0, type: "number" });
const eq0 = (key) => ({ key, operation: "eq", value: 0, type: "number" });

async function query(body) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ queryId: "shadow-report", timeframe, ...body }),
    },
  );
  const json = await res.json();
  if (!json.success) throw new Error(`telemetry query failed: ${JSON.stringify(json.errors)}`);
  return json.result;
}

let sampled = false;

/** Count of matching lines; with `groupBy`, a Map of group value → count. */
async function count(filters, groupBy) {
  const result = await query({
    view: "calculations",
    parameters: {
      datasets: ["cloudflare-workers"],
      filters,
      calculations: [{ operator: "count" }],
      ...(groupBy ? { groupBys: [{ type: "string", value: groupBy }], limit: 1000 } : {}),
    },
  });
  const aggregates = result.calculations?.[0]?.aggregates ?? [];
  if (aggregates.some((a) => (a.sampleInterval ?? 1) > 1)) sampled = true;
  if (!groupBy) return aggregates[0]?.count ?? 0;
  return new Map(aggregates.map((a) => [a.groupKey, a.count]));
}

/** Every matching line, paged to the end. Only for rare lines (mismatches). */
async function events(filters) {
  const out = [];
  let offset;
  for (;;) {
    const result = await query({
      view: "events",
      limit: PAGE,
      ...(offset ? { offset, offsetDirection: "next" } : {}),
      parameters: { datasets: ["cloudflare-workers"], filters },
    });
    const page = result.events?.events ?? [];
    out.push(...page);
    offset = page.at(-1)?.$metadata?.id;
    if (page.length === 0 || !offset) return out;
  }
}

const [
  syncs,
  withFanout,
  indexOnly,
  missingLines,
  extraLines,
  attachmentsByRepo,
  readFailed,
  readTimedOut,
] = await Promise.all([
  count(shadowFilters),
  count([...shadowFilters, gt0("fanout")]),
  count([...shadowFilters, eq0("fanout"), gt0("index")]),
  events([...shadowFilters, gt0("missingCount")]),
  events([...shadowFilters, gt0("extraCount")]),
  count([...shadowFilters, gt0("fanout")], "repo"),
  count([
    {
      key: "$metadata.message",
      operation: "eq",
      value: "attachment index: shadow read failed",
      type: "string",
    },
    service,
  ]),
  count([
    {
      key: "$metadata.message",
      operation: "eq",
      value: "attachment index: shadow read timed out",
      type: "string",
    },
    service,
  ]),
]);

const mismatches = new Map();
for (const e of [...missingLines, ...extraLines])
  mismatches.set(e.$metadata?.id ?? JSON.stringify(e.source), e.source ?? {});
const lines = [...mismatches.values()];
const tally = (field) => {
  const counts = new Map();
  for (const l of lines)
    for (const key of l[field] ?? []) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
};
const byRepo = new Map(
  [...attachmentsByRepo].map(([repo, n]) => [repo, { syncs: n, matched: n, missing: 0, extra: 0 }]),
);
for (const l of lines) {
  const r = byRepo.get(l.repo) ?? { syncs: 0, matched: 0, missing: 0, extra: 0 };
  if (l.fanout > 0) r.matched -= 1;
  r.missing += l.missingCount ?? 0;
  r.extra += l.extraCount ?? 0;
  byRepo.set(l.repo, r);
}

const syncsWithAttachments = withFanout + indexOnly;
const mismatchedWithAttachments = lines.filter((l) => l.fanout > 0 || l.index > 0).length;
const report = {
  hours,
  sampled,
  syncs,
  matched: syncs - lines.length,
  syncsWithAttachments,
  matchedWithAttachments: syncsWithAttachments - mismatchedWithAttachments,
  missingTotal: lines.reduce((n, l) => n + (l.missingCount ?? 0), 0),
  extraTotal: lines.reduce((n, l) => n + (l.extraCount ?? 0), 0),
  topMissing: tally("missing"),
  topExtra: tally("extra"),
  byRepo: [...byRepo.entries()].sort((a, b) => b[1].syncs - a[1].syncs),
  errors: {
    "attachment index: shadow read failed": readFailed,
    "attachment index: shadow read timed out": readTimedOut,
  },
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const approx = sampled ? "≈" : "";
  const pct = (a, b) => (b === 0 ? "n/a" : `${((100 * a) / b).toFixed(1)}%`);
  console.log(`attachment-index shadow, last ${hours}h`);
  console.log(
    `  syncs shadowed:          ${approx}${report.syncs}  (match ${pct(report.matched, report.syncs)})`,
  );
  console.log(
    `  with real attachments:   ${approx}${report.syncsWithAttachments}  (match ${pct(report.matchedWithAttachments, report.syncsWithAttachments)})`,
  );
  console.log(`  mismatched syncs:        ${lines.length}`);
  console.log(`  missing from index:      ${report.missingTotal}`);
  console.log(`  extra in index:          ${report.extraTotal}`);
  console.log(`  read failed / timed out: ${readFailed} / ${readTimedOut}`);
  if (report.byRepo.length) {
    console.log("  by repo (syncs with attachments):");
    for (const [repo, r] of report.byRepo)
      console.log(`    ${repo}: ${approx}${r.syncs} syncs, ${r.missing} missing, ${r.extra} extra`);
  }
  if (report.topMissing.length) {
    console.log("  top missing keys:");
    for (const [key, n] of report.topMissing) console.log(`    ${n}x ${key}`);
  }
  if (report.topExtra.length) {
    console.log("  top extra keys:");
    for (const [key, n] of report.topExtra) console.log(`    ${n}x ${key}`);
  }
  if (sampled)
    console.log("  (≈: the backend sampled this window; counts are its extrapolated estimate)");
  if (report.syncs === 0)
    console.log(
      "  (no shadow lines: flag off, no comment syncs in the window, or the deploy is not live)",
    );
}
