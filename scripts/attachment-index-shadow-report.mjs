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

const LIMIT = 1000;
const now = Date.now();
const timeframe = { from: now - hours * 3_600_000, to: now };
const service = { key: "$metadata.service", operation: "eq", value: "uploads-api", type: "string" };

async function query(queryId, filters, view = "events", extra = {}) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        queryId,
        timeframe,
        parameters: {
          datasets: ["cloudflare-workers"],
          filters: [service, ...filters],
          limit: LIMIT,
          ...extra,
        },
        view,
      }),
    },
  );
  const body = await res.json();
  if (!body.success) throw new Error(`telemetry query failed: ${JSON.stringify(body.errors)}`);
  return body.result;
}

const shadow = await query("shadow", [
  { key: "component", operation: "eq", value: "attachment-index", type: "string" },
  { key: "event", operation: "eq", value: "shadow", type: "string" },
]);
const lines = (shadow.events?.events ?? []).map((e) => e.source ?? {});

const errors = {};
for (const message of [
  "attachment index: shadow read failed",
  "attachment index: shadow read timed out",
]) {
  const r = await query("err", [
    { key: "$metadata.message", operation: "eq", value: message, type: "string" },
  ]);
  errors[message] = (r.events?.events ?? []).length;
}

const withAttachments = lines.filter((l) => l.fanout > 0 || l.index > 0);
const matched = lines.filter((l) => l.match === true);
const matchedWithAttachments = withAttachments.filter((l) => l.match === true);
const tally = (field) => {
  const counts = new Map();
  for (const l of lines)
    for (const key of l[field] ?? []) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
};
const byRepo = new Map();
for (const l of withAttachments) {
  const r = byRepo.get(l.repo) ?? { syncs: 0, matched: 0, missing: 0, extra: 0 };
  r.syncs += 1;
  if (l.match) r.matched += 1;
  r.missing += l.missingCount ?? 0;
  r.extra += l.extraCount ?? 0;
  byRepo.set(l.repo, r);
}

const report = {
  hours,
  truncated: lines.length >= LIMIT,
  syncs: lines.length,
  matched: matched.length,
  syncsWithAttachments: withAttachments.length,
  matchedWithAttachments: matchedWithAttachments.length,
  missingTotal: lines.reduce((n, l) => n + (l.missingCount ?? 0), 0),
  extraTotal: lines.reduce((n, l) => n + (l.extraCount ?? 0), 0),
  topMissing: tally("missing"),
  topExtra: tally("extra"),
  byRepo: [...byRepo.entries()].sort((a, b) => b[1].syncs - a[1].syncs),
  errors,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const pct = (a, b) => (b === 0 ? "n/a" : `${((100 * a) / b).toFixed(1)}%`);
  console.log(
    `attachment-index shadow, last ${hours}h${report.truncated ? " (truncated at " + LIMIT + " lines)" : ""}`,
  );
  console.log(
    `  syncs shadowed:          ${report.syncs}  (match ${pct(report.matched, report.syncs)})`,
  );
  console.log(
    `  with real attachments:   ${report.syncsWithAttachments}  (match ${pct(report.matchedWithAttachments, report.syncsWithAttachments)})`,
  );
  console.log(`  missing from index:      ${report.missingTotal}`);
  console.log(`  extra in index:          ${report.extraTotal}`);
  console.log(
    `  read failed / timed out: ${errors["attachment index: shadow read failed"]} / ${errors["attachment index: shadow read timed out"]}`,
  );
  if (report.byRepo.length) {
    console.log("  by repo (syncs with attachments):");
    for (const [repo, r] of report.byRepo)
      console.log(
        `    ${repo}: ${r.syncs} syncs, ${r.matched} matched, ${r.missing} missing, ${r.extra} extra`,
      );
  }
  if (report.topMissing.length) {
    console.log("  top missing keys:");
    for (const [key, n] of report.topMissing) console.log(`    ${n}x ${key}`);
  }
  if (report.topExtra.length) {
    console.log("  top extra keys:");
    for (const [key, n] of report.topExtra) console.log(`    ${n}x ${key}`);
  }
  if (report.syncs === 0)
    console.log(
      "  (no shadow lines: flag off, no comment syncs in the window, or the deploy is not live)",
    );
}
