/**
 * Client-side provenance headers for put (X-Uploads-Meta-*).
 * API allowlists keys; secrets never go here.
 */
import type { ProvenanceInput } from "./client.js";
import { createRequire } from "node:module";

let cachedVersion: string | undefined;

function packageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    cachedVersion = pkg.version ?? "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

export function buildCliProvenance(opts: {
  sourceName: string;
  optimized?: boolean;
  frameId?: string;
  keepExif?: boolean;
  client?: string;
}): ProvenanceInput {
  const provenance: ProvenanceInput = {
    client: opts.client ?? "uploads-cli",
    "client-version": packageVersion(),
    "source-name": opts.sourceName.slice(0, 128),
  };
  if (opts.optimized) provenance.optimized = "1";
  if (opts.frameId) provenance.frame = opts.frameId.slice(0, 64);
  if (opts.keepExif) provenance["keep-exif"] = "1";
  return provenance;
}
