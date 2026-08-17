/**
 * No-project-context nudge (issue #692 follow-up): a path-tagged upload with
 * no repo/gh.repo/app metadata and no real (non-local) origin lands in the
 * screenshots page's "local dev" / "Other" fallback buckets. One advisory
 * stderr line teaches the fix at the moment the context went missing. The
 * predicate mirrors apps/api's projectLabelFromMeta fallback rules exactly —
 * a real URL host is a meaningful group, so it never fires there.
 */

/** Hosts that identify a dev machine, not an app — same set as the API's
 * isLocalHostname (apps/api/src/file-metadata.ts). */
function isLocalHostname(hostname: string): boolean {
  const bare = hostname.toLowerCase();
  return (
    bare === "localhost" ||
    bare.endsWith(".localhost") ||
    bare === "127.0.0.1" ||
    bare === "0.0.0.0" ||
    bare === "[::1]"
  );
}

export function noProjectContextNudge(
  meta: Record<string, string> | undefined,
): string | undefined {
  // Only `path`-tagged uploads appear on the screenshots page at all.
  if (!meta?.path) return undefined;
  if (meta.repo || meta["gh.repo"] || meta.app) return undefined;
  let bucket = "Other";
  if (meta.url) {
    try {
      const parsed = new URL(meta.url);
      if (!isLocalHostname(parsed.hostname)) return undefined; // real host = real group
      bucket = "local dev";
    } catch {
      // unparseable url is just "no url"
    }
  }
  return (
    `note: no repo detected — the screenshots page will group this under "${bucket}". ` +
    `Run from inside your project repo, or pass --app <name>.`
  );
}
