#!/usr/bin/env node
/**
 * Issue #754 item 1 — one-time data move from the dedicated auth D1
 * (uploads-auth) into the main D1 (uploads-production), once the merged
 * schema (apps/api/migrations/20260822120000_auth_tables.sql) is live on the
 * destination.
 *
 * This is a Phase 1 deliverable: it is written and tested against LOCAL D1
 * (both `--local` simulators are just files under .wrangler/state — no
 * network calls), and is NOT wired into any CI workflow. Running it against
 * `--remote` is the actual prod cutover step described in
 * .context/754-auth-d1-merge-plan.md — do that as a deliberate, supervised
 * action (maintenance window, fresh `wrangler d1 export` backup of both
 * databases first, apps/auth's wrangler.jsonc D1 binding flipped to the main
 * DB in the same change so nothing writes to the old DB after the copy)
 * rather than by running this script on a whim.
 *
 * What it does, per table (in FK-safe order):
 *   1. `wrangler d1 execute <source> --json --command "SELECT * FROM <table>"`
 *   2. Turn each row into a plain `INSERT` statement. A conflict here (e.g.
 *      an unexpected pre-existing row with the same primary key at the
 *      destination) is NOT silently swallowed — wrangler fails the `d1
 *      execute --file` call and this script throws. The one documented
 *      exception is `oauth_client`'s CLI seed row (see
 *      `OAUTH_CLIENT_SEED_ID` below): the merged migration
 *      (apps/api/migrations/20260822120000_auth_tables.sql) already seeds
 *      that exact row with `INSERT OR IGNORE`, which always collides with
 *      the source's real historical row of the same id. This script deletes
 *      the migration's seed row from the destination immediately before
 *      copying `oauth_client`, so the source's authoritative row (real
 *      `created_at`, any admin edits made in prod) lands via the same plain
 *      `INSERT` as every other row, instead of being dropped by an
 *      ignore-on-conflict insert.
 *   3. `wrangler d1 execute <dest> --file=<tmp>.sql` to apply them.
 *   4. Verify by primary-key set, not aggregate count: for each table, every
 *      primary key present in the source must also be present in the
 *      destination afterward. A plain row count can read "OK" even when
 *      rows silently failed to copy (e.g. old `INSERT OR IGNORE` dropping a
 *      row on an `email` unique conflict while an unrelated row happened to
 *      make up the count) — set membership catches that.
 *
 * Usage:
 *   node scripts/auth-d1-data-move.mjs --local              # default, safe
 *   node scripts/auth-d1-data-move.mjs --remote              # prod cutover only
 *   node scripts/auth-d1-data-move.mjs --local --dry-run      # export + count, no import
 *   node scripts/auth-d1-data-move.mjs --local --tables=user,session
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const AUTH_DIR = resolve(REPO_ROOT, "apps/auth");
const API_DIR = resolve(REPO_ROOT, "apps/api");

// FK-safe insert order: referenced tables before their referencers.
const AUTH_TABLES = [
  "user",
  "organization",
  "session",
  "account",
  "verification",
  "rate_limit",
  "member",
  "invitation",
  "device_code",
  "jwks",
  "oauth_client",
  "oauth_resource",
  "oauth_client_resource",
  "oauth_client_assertion",
  "oauth_access_token",
  "oauth_refresh_token",
  "oauth_consent",
  "oauth_workspace_choice",
  "subscription",
  "billing_plan_outbox",
  "github_identity",
];

/** Primary-key column per table, used for post-copy set verification. */
const PRIMARY_KEYS = {
  user: "id",
  organization: "id",
  session: "id",
  account: "id",
  verification: "id",
  rate_limit: "id",
  member: "id",
  invitation: "id",
  device_code: "id",
  jwks: "id",
  oauth_client: "id",
  oauth_resource: "id",
  oauth_client_resource: "id",
  oauth_client_assertion: "id",
  oauth_access_token: "id",
  oauth_refresh_token: "id",
  oauth_consent: "id",
  oauth_workspace_choice: "user_id",
  subscription: "id",
  billing_plan_outbox: "reference_id",
  github_identity: "account_id",
};

// Seeded by apps/api/migrations/20260822120000_auth_tables.sql via
// INSERT OR IGNORE so a fresh merged database has a working CLI OAuth
// client before any data move runs. Deleted from the destination right
// before the real `oauth_client` copy — see the header comment.
const OAUTH_CLIENT_SEED_ID = "oc_uploads_cli_seed";

function parseArgs(argv) {
  const args = { mode: "--local", dryRun: false, tables: null };
  for (const arg of argv) {
    if (arg === "--local" || arg === "--remote") args.mode = arg;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg.startsWith("--tables=")) args.tables = arg.slice("--tables=".length).split(",");
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}. See --help.`);
  }
  return args;
}

function usage() {
  console.log(`Usage: node scripts/auth-d1-data-move.mjs [--local|--remote] [--dry-run] [--tables=a,b,c]

  --local      Target both databases' local D1 simulators (default; no network calls).
  --remote     Target the real Cloudflare D1 databases. This IS the prod cutover step —
               only run it as part of the documented cutover in
               .context/754-auth-d1-merge-plan.md, after a fresh backup of both databases.
  --dry-run    Export and report row counts from the source only; skip the import.
  --tables=... Comma-separated table subset (default: all ${AUTH_TABLES.length} auth tables).
`);
}

/** Run a wrangler d1 command from a given cwd and return parsed stdout. */
function wranglerJson(cwd, args) {
  const result = spawnSync(
    process.execPath,
    [resolve(cwd, "node_modules/wrangler/bin/wrangler.js"), "d1", ...args, "--json"],
    { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `wrangler d1 ${args.join(" ")} (cwd=${cwd}) failed:\n${result.stderr || result.stdout}`,
    );
  }
  // `--json` prints one JSON array of per-statement results; wrangler also
  // sometimes prefixes informational lines before the JSON on stdout, so
  // parse from the first `[`.
  const jsonStart = result.stdout.indexOf("[");
  if (jsonStart === -1) {
    throw new Error(`wrangler d1 ${args.join(" ")}: no JSON found in output:\n${result.stdout}`);
  }
  return JSON.parse(result.stdout.slice(jsonStart));
}

function selectAll(dir, database, table, mode) {
  const out = wranglerJson(dir, ["execute", database, mode, "--command", `SELECT * FROM ${table}`]);
  return out[0]?.results ?? [];
}

function countRows(dir, database, table, mode) {
  const out = wranglerJson(dir, [
    "execute",
    database,
    mode,
    "--command",
    `SELECT COUNT(*) AS n FROM ${table}`,
  ]);
  return Number(out[0]?.results?.[0]?.n ?? 0);
}

/** SQLite string literal: wrap in single quotes, double embedded quotes. */
function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return sqlString(value);
}

function rowsToInserts(table, rows) {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]);
  const statements = rows.map((row) => {
    const values = columns.map((col) => sqlLiteral(row[col]));
    return `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${values.join(", ")});`;
  });
  return statements.join("\n") + "\n";
}

/** All primary-key values for a table, as strings (for set comparison). */
function selectPks(dir, table, mode) {
  const pk = PRIMARY_KEYS[table];
  const out = wranglerJson(dir, [
    "execute",
    "DB",
    mode,
    "--command",
    `SELECT "${pk}" AS pk FROM ${table}`,
  ]);
  return new Set((out[0]?.results ?? []).map((row) => String(row.pk)));
}

/**
 * Deletes the merged migration's `oauth_client` seed row from the
 * destination, so the source's real row of the same id can land via a plain
 * (conflict-failing) INSERT instead of colliding with it. No-op for every
 * other table.
 */
function cleanUpSeedException(table, mode) {
  if (table !== "oauth_client") return;
  wranglerJson(API_DIR, [
    "execute",
    "DB",
    mode,
    "--command",
    `DELETE FROM oauth_client WHERE id = '${OAUTH_CLIENT_SEED_ID}'`,
  ]);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();

  const mode = args.mode; // "--local" | "--remote"
  // Filter the canonical FK-safe list down to the requested subset, rather
  // than using the caller's `--tables=` order directly — `--tables=session,user`
  // must still insert `user` before `session`, since `session.user_id`
  // references it.
  const unknown = args.tables?.filter((t) => !AUTH_TABLES.includes(t)) ?? [];
  if (unknown.length > 0) {
    throw new Error(`Unknown table(s): ${unknown.join(", ")}. Known: ${AUTH_TABLES.join(", ")}`);
  }
  const tables = args.tables ? AUTH_TABLES.filter((t) => args.tables.includes(t)) : AUTH_TABLES;

  if (mode === "--remote") {
    console.log(
      "⚠  --remote targets the real Cloudflare D1 databases. This is the prod cutover step —\n" +
        "   make sure you have followed .context/754-auth-d1-merge-plan.md (backups taken,\n" +
        "   apps/auth's wrangler.jsonc D1 binding ready to flip in the same change) before continuing.\n",
    );
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "auth-d1-move-"));
  const summary = [];
  try {
    for (const table of tables) {
      process.stdout.write(`\n== ${table} ==\n`);
      const sourceCount = countRows(AUTH_DIR, "DB", table, mode);
      process.stdout.write(`  source (uploads-auth) rows: ${sourceCount}\n`);

      if (args.dryRun) {
        summary.push({ table, sourceCount, destCountBefore: null, destCountAfter: null });
        continue;
      }

      const rows = selectAll(AUTH_DIR, "DB", table, mode);
      const destCountBefore = countRows(API_DIR, "DB", table, mode);

      cleanUpSeedException(table, mode);

      if (rows.length > 0) {
        const sql = rowsToInserts(table, rows);
        const file = join(tmpDir, `${table}.sql`);
        writeFileSync(file, sql, "utf8");
        wranglerJson(API_DIR, ["execute", "DB", mode, "--file", file]);
      }

      const destCountAfter = countRows(API_DIR, "DB", table, mode);
      const sourcePks = selectPks(AUTH_DIR, table, mode);
      const destPks = selectPks(API_DIR, table, mode);
      const missing = [...sourcePks].filter((pk) => !destPks.has(pk));
      process.stdout.write(
        `  destination (uploads-api) rows: ${destCountBefore} -> ${destCountAfter}\n`,
      );
      summary.push({ table, sourceCount, destCountBefore, destCountAfter, missing });
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("\n== Primary-key verification ==");
  let failed = false;
  for (const row of summary) {
    if (args.dryRun) {
      console.log(`${row.table}: source=${row.sourceCount} (dry run, no import)`);
      continue;
    }
    // Authoritative check: every primary key present in the source must be
    // present in the destination. A count comparison alone can't catch a
    // row that silently failed to copy while an unrelated row made up the
    // number.
    const ok = row.missing.length === 0;
    if (!ok) failed = true;
    console.log(
      `${row.table}: source=${row.sourceCount} dest_after=${row.destCountAfter} ${
        ok
          ? "OK"
          : `MISMATCH (missing ${row.missing.length}: ${row.missing.slice(0, 5).join(", ")}${row.missing.length > 5 ? ", …" : ""})`
      }`,
    );
  }

  if (failed) {
    console.error(
      "\nPrimary-key verification FAILED for at least one table. Do not proceed with cutover.",
    );
    process.exitCode = 1;
  } else if (!args.dryRun) {
    console.log("\nAll tables verified.");
  }
}

main();
