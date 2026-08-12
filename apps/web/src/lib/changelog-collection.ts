/**
 * Isolated `astro:content` access for the `changelog` collection.
 *
 * Kept in its own module so `changelog.ts`'s pure functions stay importable
 * from vitest without a top-level `astro:content` import, which vitest
 * cannot resolve outside an Astro build.
 */
import type { CollectionEntry } from "astro:content";
import { getCollection } from "astro:content";

export type ChangelogPost = CollectionEntry<"changelog">;

export function getChangelogCollection(): Promise<ChangelogPost[]> {
  return getCollection("changelog");
}
