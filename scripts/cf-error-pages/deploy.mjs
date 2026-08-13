#!/usr/bin/env node
/**
 * Publishes the pages built by ./build.mjs and wires them into the uploads.sh
 * zone: the `PAGES` entries become Cloudflare Error Pages, the `RULES` entries
 * become Custom Error Rules (see ./pages.mjs for why both are needed).
 *
 * Usage (from the repo root, with .env loaded):
 *   node scripts/cf-error-pages/build.mjs
 *   node scripts/cf-error-pages/deploy.mjs --dry-run
 *   node scripts/cf-error-pages/deploy.mjs
 *   node scripts/cf-error-pages/deploy.mjs --only 500_errors,waf_block
 *   node scripts/cf-error-pages/deploy.mjs --revert          # back to Cloudflare defaults
 *
 * Two steps per page:
 *   1. `wrangler r2 object put` into the server-owned `_internal/` namespace of
 *      the uploads-default bucket. That prefix is filtered out of every listing
 *      (apps/api/src/files-core.ts) but is publicly fetchable at
 *      storage.uploads.sh — the same arrangement the transactional email mark
 *      uses (packages/email/src/card.ts).
 *   2. `PUT /zones/:zone/custom_pages/:id` with that URL. Cloudflare fetches the
 *      HTML once, validates that the required token is present, and caches the
 *      content itself. Nothing is fetched from storage.uploads.sh at error time,
 *      which is what makes it safe to host the "origin is down" page on the
 *      origin's own storage domain.
 *
 * Keys are content-addressed (`<page-id>-<sha256-8>.html`) so a re-deploy of
 * unchanged HTML is a no-op and Cloudflare never re-fetches a URL whose bytes
 * changed underneath it — the same immutable-key discipline as the email mark.
 *
 * Requires CLOUDFLARE_API_TOKEN with, on the uploads.sh zone:
 *   - Zone → Custom Pages → Edit    (Error Pages, and the stored-asset endpoints)
 *   - Zone → Config Rules → Edit    (the http_custom_errors ruleset)
 *   - Account → Workers R2 Storage → Edit   (the wrangler r2 object put)
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { PAGES, RULES } from "./pages.mjs";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const ZONE = "e6350abfdaa46c08b9597190ac0c5911"; // uploads.sh
const BUCKET = "uploads-default";
const PREFIX = "_internal/cf-error-pages";
const PUBLIC_ORIGIN = "https://storage.uploads.sh";
const API = "https://api.cloudflare.com/client/v4";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const revert = argv.includes("--revert");
const onlyArg = argv[argv.indexOf("--only") + 1];
const only = argv.includes("--only") ? new Set(onlyArg.split(",").map((s) => s.trim())) : null;

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set — source .env first");

/** Cloudflare's envelope is uniform; unwrap it and surface `errors` verbatim. */
async function cf(pathname, init = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const body = await res.json();
  if (!body.success) {
    const detail = (body.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(
      `${init.method ?? "GET"} ${pathname} → ${res.status} ${detail || "unknown error"}`,
    );
  }
  return body.result;
}

const targets = PAGES.filter((p) => !only || only.has(p.id));
const ruleTargets = RULES.filter((r) => !only || only.has(r.id));
if (only) {
  const known = new Set([...PAGES, ...RULES].map((p) => p.id));
  const unknown = [...only].filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`unknown page id(s): ${unknown.join(", ")}`);
}

if (revert) {
  if (ruleTargets.length) {
    // Custom error rules live in one entrypoint ruleset; clearing its `rules`
    // array is the documented way to remove them.
    if (dryRun) console.log("[dry-run] would clear the http_custom_errors ruleset");
    else {
      await cf(`/zones/${ZONE}/rulesets/phases/http_custom_errors/entrypoint`, {
        method: "PUT",
        body: JSON.stringify({ rules: [] }),
      });
      console.log("cleared http_custom_errors ruleset");
    }
  }
  for (const page of targets) {
    if (dryRun) {
      console.log(`[dry-run] would reset ${page.id} to the Cloudflare default`);
      continue;
    }
    // `state: "default"` is how the API clears a customized page; DELETE is not
    // supported on this collection.
    await cf(`/zones/${ZONE}/custom_pages/${page.id}`, {
      method: "PUT",
      body: JSON.stringify({ state: "default", url: null }),
    });
    console.log(`reset  ${page.id} → Cloudflare default`);
  }
  process.exit(0);
}

for (const page of targets) {
  const file = path.join(here, "dist", `${page.id}.html`);
  let html;
  try {
    html = await readFile(file, "utf8");
  } catch {
    throw new Error(`missing ${path.relative(root, file)} — run build.mjs first`);
  }
  if (page.token && !html.includes(page.token)) {
    throw new Error(
      `${page.id}: rendered HTML is missing ${page.token}; Cloudflare will reject it`,
    );
  }

  const digest = createHash("sha256").update(html).digest("hex").slice(0, 8);
  const key = `${PREFIX}/${page.id}-${digest}.html`;
  const url = `${PUBLIC_ORIGIN}/${key}`;

  if (dryRun) {
    console.log(
      `[dry-run] ${page.id}\n          put ${BUCKET}/${key}\n          point custom page at ${url}`,
    );
    continue;
  }

  await run(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "put",
      `${BUCKET}/${key}`,
      "--file",
      file,
      "--content-type",
      "text/html; charset=utf-8",
      "--remote",
    ],
    { cwd: root },
  );

  // Cloudflare fetches this URL synchronously during the PUT, so a propagation
  // lag on a brand-new R2 object surfaces here as a fetch failure rather than a
  // silently-broken error page. Retry briefly before giving up.
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const probe = await fetch(url, { cache: "no-store" });
    if (probe.ok) break;
    lastErr = `${probe.status} from ${url}`;
    await new Promise((r) => setTimeout(r, attempt * 1000));
  }
  if (lastErr) {
    const final = await fetch(url, { cache: "no-store" });
    if (!final.ok) throw new Error(`uploaded object not publicly readable: ${lastErr}`);
  }

  await cf(`/zones/${ZONE}/custom_pages/${page.id}`, {
    method: "PUT",
    body: JSON.stringify({ url, state: "customized" }),
  });

  // Cloudflare answers `success: true` for page types the zone's plan can't
  // actually set (observed on `waf_challenge`, the legacy WAF captcha, on Pro)
  // and then quietly leaves them at `state: "default"`. Read the page back so a
  // silent no-op reports as one instead of looking like a successful deploy.
  const saved = await cf(`/zones/${ZONE}/custom_pages/${page.id}`);
  if (saved.state !== "customized") {
    console.warn(
      `SKIPPED  ${page.id.padEnd(18)} Cloudflare accepted the write but kept the default page (not available on this zone's plan)`,
    );
    continue;
  }
  console.log(`deployed ${page.id.padEnd(18)} → ${url}`);
}

/*
 * Custom Error Rules. Unlike Error Pages (which take a URL and let Cloudflare
 * re-fetch it), rules reference a *stored asset*: Cloudflare fetches the URL
 * once at registration and keeps the bytes. Asset names are content-addressed
 * for the same reason the R2 keys are — registering an existing name is an
 * error, and silently reusing a stale one would ship the wrong copy.
 */
if (ruleTargets.length) {
  const existing = await cf(`/zones/${ZONE}/custom_pages/assets`);
  const known = new Set((existing ?? []).map((a) => a.name));
  const rules = [];

  for (const rule of ruleTargets) {
    const file = path.join(here, "dist", `${rule.id}.html`);
    let html;
    try {
      html = await readFile(file, "utf8");
    } catch {
      throw new Error(`missing ${path.relative(root, file)} — run build.mjs first`);
    }

    const digest = createHash("sha256").update(html).digest("hex").slice(0, 8);
    const key = `${PREFIX}/${rule.id}-${digest}.html`;
    const url = `${PUBLIC_ORIGIN}/${key}`;
    const assetName = `${rule.id}_${digest}`;

    if (dryRun) {
      console.log(
        `[dry-run] ${rule.id}\n          put ${BUCKET}/${key}\n          register asset ${assetName}\n          rule: ${rule.expression}`,
      );
      rules.push({ assetName, rule });
      continue;
    }

    if (!known.has(assetName)) {
      await run(
        "npx",
        [
          "wrangler",
          "r2",
          "object",
          "put",
          `${BUCKET}/${key}`,
          "--file",
          file,
          "--content-type",
          "text/html; charset=utf-8",
          "--remote",
        ],
        { cwd: root },
      );
      await cf(`/zones/${ZONE}/custom_pages/assets`, {
        method: "POST",
        body: JSON.stringify({ name: assetName, description: rule.description, url }),
      });
      console.log(`registered asset ${assetName} ← ${url}`);
    } else {
      console.log(`asset ${assetName} already registered (unchanged)`);
    }
    rules.push({ assetName, rule });
  }

  const body = {
    rules: rules.map(({ assetName, rule }) => ({
      action: "serve_error",
      action_parameters: {
        asset_name: assetName,
        content_type: "text/html",
        status_code: rule.statusCode,
      },
      expression: rule.expression,
      description: rule.description,
      enabled: true,
    })),
  };

  if (dryRun) {
    console.log(
      `[dry-run] would PUT http_custom_errors ruleset:\n${JSON.stringify(body, null, 2)}`,
    );
  } else {
    // The entrypoint ruleset is replaced wholesale, so `rules` must always
    // carry every rule we want live — never just the changed one. That is why
    // `--only` on a rule id still rewrites the full set from RULES.
    const saved = await cf(`/zones/${ZONE}/rulesets/phases/http_custom_errors/entrypoint`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    console.log(`deployed ${saved.rules.length} custom error rule(s) → ruleset ${saved.id}`);
  }
}
