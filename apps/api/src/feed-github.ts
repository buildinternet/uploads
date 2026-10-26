/**
 * PR/issue title + state for the public live link header (`/c/<id>`).
 * Public audience only (spec "PR names everywhere"): verified-public repos
 * via the home installation, so a private repo's live title never reaches
 * this unauthenticated page. No stamped `gh.title` fallback: a stamp
 * belongs to one file, and a live link spans many. Never throws.
 */
import { displayTitle } from "./file-metadata";
import { resolveTitles, withPublicTitleBudget } from "./github-titles";

export interface PublicFeedGithub {
  title: string | null;
  state: "open" | "closed" | "merged" | null;
}

export async function publicFeedGithub(
  env: Env,
  record: { repo: string; number: number },
  fetchImpl?: typeof fetch,
): Promise<PublicFeedGithub | null> {
  if (!(record.number > 0)) return null;
  const ref = `${record.repo.toLowerCase()}#${record.number}`;
  try {
    const titles = await withPublicTitleBudget(
      resolveTitles(env, [ref], { audience: "public" }, fetchImpl),
    );
    const info = titles?.[ref] ?? null;
    return { title: displayTitle(info?.title) ?? null, state: info?.state ?? null };
  } catch {
    return { title: null, state: null };
  }
}
