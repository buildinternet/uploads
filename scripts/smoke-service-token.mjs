#!/usr/bin/env node
/**
 * Production smoke for workspace service tokens (issue #1026).
 *
 * Uses the CLI built from this checkout with the service token in
 * UPLOADS_TOKEN, the way a CI job would, and checks the three things a
 * service token promises:
 *
 *   1. The CLI reads the workspace from the token (no UPLOADS_WORKSPACE).
 *   2. A `gh.*`-tagged upload is attributed to the token's label
 *      (`gh.uploader-kind: service`, no `gh.uploader-id`).
 *   3. The token can read and delete what it uploaded.
 *
 * The uploaded file is deleted at the end, pass or fail. The token value is
 * never printed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const token = process.env.UPLOADS_TOKEN ?? "";
if (!token) {
  console.error("UPLOADS_TOKEN is not set");
  process.exit(1);
}
if (process.env.UPLOADS_WORKSPACE) {
  console.error("unset UPLOADS_WORKSPACE: the smoke checks that the CLI reads it from the token");
  process.exit(1);
}
if (!token.startsWith("ups_")) {
  // Service tokens minted before PR #1039 deployed start with up_. They still
  // work; mint a new one to exercise the ups_ prefix.
  console.log("::warning::UPLOADS_TOKEN does not start with ups_ (minted before #1039?)");
}

const cli = join(import.meta.dirname, "..", "packages", "uploads", "bin", "uploads.js");
/** Run a CLI command with --json; on failure, throw with its own output so CI shows why. */
function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(stdout);
  } catch (error) {
    const out = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`uploads ${args[0]} failed: ${out || error.message}`);
  }
}

/** A valid 8×8 PNG, generated so the upload passes magic-byte sniffing. */
function png() {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const size = 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  const rows = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) rows.set([0x7c, 0x3a, 0xed], y * (1 + size * 3) + 1 + x * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const file = join(mkdtempSync(join(tmpdir(), "service-token-smoke-")), "smoke.png");
writeFileSync(file, png());
const runId = process.env.GITHUB_RUN_ID ?? String(Date.now());
const key = `screenshots/smoke/service-token-${runId}.png`;
const repo = process.env.GITHUB_REPOSITORY ?? "buildinternet/uploads";

const failures = [];
let uploaded = false;
try {
  const put = run(["put", file, "--key", key, "--meta", `gh.repo=${repo}`, "--no-comment"]);
  uploaded = true;
  console.log(`uploaded ${put.key ?? key} to workspace ${put.workspace ?? "?"}`);

  const { metadata = {} } = run(["meta", "get", key]);
  if (metadata["gh.uploader-kind"] !== "service") {
    failures.push(
      `gh.uploader-kind is ${JSON.stringify(metadata["gh.uploader-kind"])}, want "service"`,
    );
  }
  if (!metadata["gh.uploader"]) failures.push("gh.uploader is empty, want the token's label");
  if ("gh.uploader-id" in metadata)
    failures.push("gh.uploader-id is set; a service token has no user");
  console.log(
    `attributed to ${JSON.stringify(metadata["gh.uploader"])} (${metadata["gh.uploader-kind"]})`,
  );
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  if (uploaded) {
    try {
      run(["delete", key]);
      console.log(`deleted ${key}`);
    } catch (error) {
      failures.push(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`::error::${failure}`);
  process.exit(1);
}
console.log("service token smoke passed");
