/**
 * Isolated `astro:content` access for the `changelog` collection.
 *
 * Kept in its own module so `changelog.ts`'s pure functions stay importable
 * from vitest without a top-level `astro:content` import, which vitest
 * cannot resolve outside an Astro build.
 *
 * The `"changelog" as never` / return cast below are load-bearing until a
 * later task registers the `changelog` collection in `content.config.ts`:
 * without that config, `astro:content`'s generated types don't know about
 * any collection name, so `getCollection` types its argument as `never`.
 * Once the collection is registered, `getCollection("changelog")` and this
 * shape will typecheck for real; the casts can be dropped then.
 */
import { getCollection } from "astro:content";

export type ChangelogPost = {
  id: string;
  body?: string;
  data: {
    title: string;
    date: Date;
    tags: string[];
    image?: { url: string; alt: string };
  };
};

export function getChangelogCollection(): Promise<ChangelogPost[]> {
  return getCollection("changelog" as never) as unknown as Promise<ChangelogPost[]>;
}
