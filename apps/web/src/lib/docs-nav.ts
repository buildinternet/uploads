// Derives the /docs chrome — left nav, prev/next chain — from the `docs`
// content collection, so adding a page is dropping an .mdx file in.
//
// The hub (/docs) is not a collection entry: it is an .astro card index. It is
// injected here as the "Overview" nav item and as both ends of the prev/next
// chain, matching what the hand-wired pages did before the migration.
import { getCollection } from "astro:content";

export interface DocsNavItem {
  slug: string;
  href: string;
  label: string;
}

export interface DocsNavSection {
  title: string;
  items: DocsNavItem[];
}

export interface DocsPageLink {
  href: string;
  label: string;
}

export const DOCS_HUB: DocsNavItem = { slug: "overview", href: "/docs", label: "Overview" };

// The agent walkthrough is its own .astro page, not a collection entry, so it
// stays hand-written at the top of the Guides group; `guides` collection
// entries follow it.
const WALKTHROUGH: DocsNavItem = {
  slug: "walkthrough",
  href: "/github-screenshots",
  label: "Agent walkthrough",
};

/** Collection entries in `navOrder` order — the canonical docs sequence. */
export async function getOrderedDocs() {
  const entries = await getCollection("docs");
  return entries.sort((a, b) => a.data.navOrder - b.data.navOrder);
}

/** Nav-slug for a guide, prefixed so it can't collide with a docs `navSlug`. */
export const guideNavSlug = (id: string) => `guide-${id}`;

/**
 * Guides in `navOrder` order. Drafts are dropped from production builds and
 * kept in dev, so a stub can be previewed before it ships.
 */
export async function getPublishedGuides() {
  const entries = await getCollection(
    "guides",
    (entry) => !import.meta.env.PROD || !entry.data.draft,
  );
  return entries.sort((a, b) => a.data.navOrder - b.data.navOrder);
}

/** Left-nav sections: the hub plus every collection entry, then Guides. */
export async function getDocsNav(): Promise<DocsNavSection[]> {
  const entries = await getOrderedDocs();
  return [
    {
      title: "Docs",
      items: [
        DOCS_HUB,
        ...entries.map((entry) => ({
          slug: entry.data.navSlug,
          href: `/docs/${entry.id}`,
          label: entry.data.navLabel,
        })),
      ],
    },
    {
      title: "Guides",
      items: [
        WALKTHROUGH,
        ...(await getPublishedGuides()).map((entry) => ({
          slug: guideNavSlug(entry.id),
          href: `/guides/${entry.id}`,
          label: entry.data.navLabel,
        })),
      ],
    },
  ];
}

/**
 * Prev/next for one entry. The chain wraps through the hub at both ends: the
 * first page goes "← Back / Overview", the last goes "Docs → / Overview".
 */
export function getDocsPagination(
  entries: Awaited<ReturnType<typeof getOrderedDocs>>,
  id: string,
): { prev: DocsPageLink; next: DocsPageLink; nextIsHub: boolean } {
  const index = entries.findIndex((entry) => entry.id === id);
  const before = index > 0 ? entries[index - 1] : undefined;
  const after = index >= 0 && index < entries.length - 1 ? entries[index + 1] : undefined;
  return {
    prev: before
      ? { href: `/docs/${before.id}`, label: before.data.navLabel }
      : { href: DOCS_HUB.href, label: DOCS_HUB.label },
    next: after
      ? { href: `/docs/${after.id}`, label: after.data.navLabel }
      : { href: DOCS_HUB.href, label: DOCS_HUB.label },
    nextIsHub: !after,
  };
}
