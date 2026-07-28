/**
 * "Did you mean" for a mistyped root command (issue #545).
 *
 * The unknown-command path used to answer with the essentials list, which
 * can't correct a wrong guess for anything outside it — `uploads set-metadata`
 * printed a help dump that never mentions `meta`. Two sources feed a
 * suggestion: a table of spellings agents actually reach for, and an edit
 * distance over the catalog. Same rule as the metadata vocabulary
 * (metadata-vocab.ts): suggest, never silently rewrite.
 */
import { ROOT_COMMANDS } from "./cli-catalog.js";

/**
 * Wrong-but-natural spellings, mapped to the command phrase that does the
 * job. Values are full phrases (`meta set`), not just root names, because the
 * work an agent wants often lives on a subcommand.
 */
const COMMAND_ALIASES: Readonly<Record<string, string>> = {
  // metadata — the case in issue #545
  setmetadata: "meta set",
  setmeta: "meta set",
  metadata: "meta set",
  metaset: "meta set",
  tag: "meta set",
  tags: "meta set",
  label: "meta set",
  getmetadata: "meta get",
  getmeta: "meta get",
  showmetadata: "meta get",
  metaget: "meta get",
  // upload
  upload: "put",
  uploadfile: "put",
  cp: "put",
  copy: "put",
  send: "put",
  // listing and search
  ls: "list",
  files: "list",
  objects: "list",
  search: "find",
  query: "find",
  filter: "find",
  // removal
  rm: "delete",
  remove: "delete",
  del: "delete",
  destroy: "delete",
  // capture
  capture: "screenshot",
  shot: "screenshot",
  snap: "screenshot",
  screengrab: "screenshot",
  screencapture: "screenshot",
  // session
  signin: "login",
  auth: "login",
  authenticate: "login",
  signout: "logout",
  // github
  pr: "attach",
  issue: "attach",
  upsertcomment: "comment",
};

/** Compare on letters and digits only, so `set-metadata` ≡ `set_metadata`. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Plain Levenshtein distance (two-row); inputs here are a few characters. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

/** Crude de-pluralizer, so `galleries` still reaches `gallery`. */
function singular(value: string): string {
  if (value.endsWith("ies") && value.length > 4) return `${value.slice(0, -3)}y`;
  if (value.endsWith("es") && value.length > 3) return value.slice(0, -2);
  if (value.endsWith("s") && value.length > 3) return value.slice(0, -1);
  return value;
}

/** Short words tolerate one typo, longer ones two. */
function threshold(length: number): number {
  if (length <= 3) return 0;
  if (length <= 5) return 1;
  return 2;
}

/**
 * The command phrase a mistyped command most likely meant, or undefined when
 * nothing is close enough to be worth printing. Aliases win over distance so
 * `metadata` resolves to `meta set` rather than the bare `meta` group.
 */
export function suggestCommand(input: string): string | undefined {
  const norm = normalize(input);
  if (!norm) return undefined;

  const alias = COMMAND_ALIASES[norm];
  if (alias) return alias;

  let best: { phrase: string; distance: number } | undefined;
  const consider = (candidate: string, phrase: string, allowContainment: boolean): void => {
    // A plural or a trailing qualifier (`screenshots`, `put-file`) is the same
    // intent, not a typo — treat containment as a very strong match.
    const contained =
      allowContainment &&
      candidate.length >= 3 &&
      (norm.startsWith(candidate) || candidate.startsWith(norm));
    const distance = contained
      ? 0
      : Math.min(editDistance(norm, candidate), editDistance(singular(norm), candidate));
    if (!contained && distance > threshold(Math.max(norm.length, candidate.length))) return;
    if (!best || distance < best.distance) best = { phrase, distance };
  };

  for (const cmd of ROOT_COMMANDS) consider(normalize(cmd.name), cmd.name, true);
  // Aliases join the fuzzy pass too, so a typo *of* a synonym (`uplaod`) still
  // lands. No containment for these — an alias is a whole word, and `tag` as a
  // prefix would swallow unrelated input.
  for (const [spelling, phrase] of Object.entries(COMMAND_ALIASES)) {
    consider(spelling, phrase, false);
  }
  return best?.phrase;
}

/** Catalog summary for a suggested phrase (`meta set` → the subcommand's). */
export function commandSummary(phrase: string): string | undefined {
  const [name, sub] = phrase.split(" ");
  const cmd = ROOT_COMMANDS.find((c) => c.name === name);
  if (!cmd) return undefined;
  if (!sub) return cmd.summary;
  return cmd.subcommands?.find((s) => s.name === sub)?.summary;
}
