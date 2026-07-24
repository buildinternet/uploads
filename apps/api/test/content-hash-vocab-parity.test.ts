/// <reference types="node" />

/**
 * Drift guard for the one fact this app deliberately duplicates.
 *
 * `INHERITABLE_META_KEYS` (apps/api) restates `CANONICAL_META_KEYS`
 * (packages/uploads) because neither side can import the other: the CLI package
 * is published and carries no `@uploads/*` workspace deps, so it cannot depend
 * on a shared private package; and `apps/api` importing the CLI would invert the
 * dependency and drag CLI deps toward a Worker bundle. Same reasoning as
 * `packages/billing/src/workspace-cap.ts` restating the record shape it needs.
 *
 * The duplication is only safe if drift fails a test. Without this, a key added
 * to the CLI's canonical vocabulary would silently be non-inheritable
 * server-side — no compiler error, no failing test, just metadata quietly not
 * surviving the seam this feature exists to close (#479).
 *
 * The vocabulary is read out of the CLI's *source* rather than imported: it is
 * not in that package's public exports, and its `exports` map points at built
 * `dist/`, so importing it would make this test depend on a CLI build.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { INHERITABLE_META_KEYS } from "../src/content-hash";

const VOCAB_SOURCE = fileURLToPath(
  new NodeURL("../../../packages/uploads/src/metadata-vocab.ts", import.meta.url),
);

/** Pull the `CANONICAL_META_KEYS` array literal out of the CLI source. */
function readCanonicalKeys(): string[] {
  const source = readFileSync(VOCAB_SOURCE, "utf8");
  const match = source.match(/export const CANONICAL_META_KEYS = \[([^\]]*)\] as const;/);
  if (!match) {
    throw new Error(
      `could not find CANONICAL_META_KEYS in ${VOCAB_SOURCE} — if the CLI renamed or reshaped it, update this parity test rather than deleting it`,
    );
  }
  return [...match[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("inheritable vocabulary parity with the CLI", () => {
  it("finds the canonical vocabulary in the CLI source", () => {
    expect(readCanonicalKeys().length).toBeGreaterThan(0);
  });

  it("matches CANONICAL_META_KEYS exactly", () => {
    // Order-insensitive: the api uses a Set for lookup, so only membership is
    // load-bearing. A mismatch here means the two lists drifted — add the key
    // to INHERITABLE_META_KEYS (or, if it must not be inheritable, say why in
    // a comment there and adjust this expectation deliberately).
    expect([...INHERITABLE_META_KEYS].sort()).toEqual(readCanonicalKeys().sort());
  });
});
