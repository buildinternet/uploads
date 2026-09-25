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
// is hand-written into the "Get started" section.
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

/** Sidebar section titles, in display order. Keys match the docs `navGroup` field. */
const DOCS_GROUPS = [
  { key: "start", title: "Get started" },
  { key: "media", title: "Share media" },
  { key: "github", title: "GitHub" },
  { key: "workspace", title: "Workspace" },
] as const;

/**
 * Left-nav sections: docs entries grouped by `navGroup` (the hub and the
 * agent walkthrough open "Get started"), then the use-case guides.
 */
export async function getDocsNav(): Promise<DocsNavSection[]> {
  const entries = await getOrderedDocs();
  const sections: DocsNavSection[] = DOCS_GROUPS.map(({ key, title }) => ({
    title,
    items: entries
      .filter((entry) => entry.data.navGroup === key)
      .map((entry) => ({
        slug: entry.data.navSlug,
        href: `/docs/${entry.id}`,
        label: entry.data.navLabel,
      })),
  }));
  sections[0].items.unshift(DOCS_HUB);
  sections[0].items.push(WALKTHROUGH);
  const guides = await getPublishedGuides();
  if (guides.length > 0) {
    sections.push({
      title: "Guides",
      items: guides.map((entry) => ({
        slug: guideNavSlug(entry.id),
        href: `/guides/${entry.id}`,
        label: entry.data.navLabel,
      })),
    });
  }
  return sections.filter((section) => section.items.length > 0);
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
