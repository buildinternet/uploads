import { glob } from "astro/loaders";
import { defineCollection, z } from "astro:content";

/**
 * Platform updates for /changelog. One .md per update; slug = filename.
 * Screenshots are NEVER committed — upload to the buildinternet workspace
 * (changelog/ prefix) and reference the absolute storage.uploads.sh URL.
 * See src/content/changelog/README.md for the publishing workflow.
 */
const changelog = defineCollection({
  // README.md is the authoring guide, not an entry — exclude it.
  loader: glob({ pattern: ["*.md", "!README.md"], base: "./src/content/changelog" }),
  schema: z.object({
    title: z.string().min(1),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    image: z
      .object({
        url: z.string().url().startsWith("https://"),
        alt: z.string().min(1),
      })
      .optional(),
  }),
});

/**
 * Docs subject pages for /docs/<slug>. One .mdx per page; the entry id is the
 * URL slug, so adding a page is dropping a file in — the left nav, the
 * prev/next chain, and the static path all derive from the frontmatter below.
 *
 * The hub itself (/docs) stays an .astro page: it is a card index, not prose.
 * `navOrder` drives BOTH the sidebar order and the prev/next chain, with the
 * hub sitting at either end of that chain.
 */
const docs = defineCollection({
  loader: glob({ pattern: "*.mdx", base: "./src/content/docs" }),
  schema: z.object({
    /** <title> and the og/twitter title (suffixed with " · uploads.sh"). */
    title: z.string().min(1),
    /** Meta description + og/twitter description. */
    description: z.string().min(1),
    /** The <h1> shown above the article. */
    heading: z.string().min(1),
    /** One-line subtitle under the <h1>. */
    tagline: z.string().min(1),
    /** Sidebar label — often shorter than `heading`. */
    navLabel: z.string().min(1),
    /** Sidebar/active-state key; matched against DocsLayout's `active` prop. */
    navSlug: z.string().min(1),
    /** Sidebar order and the prev/next chain. Lower comes first. */
    navOrder: z.number().int().positive(),
    /** Optional "on this page" rail. Omit it and the rail is not rendered. */
    toc: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })).optional(),
  }),
});

/**
 * Use-case guides for /guides/<slug>. Problem-first pages ("attach a PDF to a
 * PR from the CLI") where docs pages are feature-first. Each one answers a
 * question someone, or their agent, would search for, so the page leads
 * with the answer and carries FAQ structured data.
 *
 * `draft: true` keeps a guide out of production builds (route, nav, and
 * docs.json) while it is being written; `pnpm dev` still renders it.
 */
const guides = defineCollection({
  loader: glob({ pattern: "*.mdx", base: "./src/content/guides" }),
  schema: z.object({
    /** <title> and the og/twitter title (suffixed with " · uploads.sh"). */
    title: z.string().min(1),
    /** Meta description + og/twitter description. */
    description: z.string().min(1),
    /** The <h1> shown above the article. */
    heading: z.string().min(1),
    /** One-line subtitle under the <h1>. */
    tagline: z.string().min(1),
    /** Sidebar label under "Guides". */
    navLabel: z.string().min(1),
    /** Order within the Guides nav group. Lower comes first. */
    navOrder: z.number().int().positive(),
    draft: z.boolean().default(false),
    /** Rendered as an on-page FAQ and as FAQPage JSON-LD. */
    faq: z.array(z.object({ q: z.string().min(1), a: z.string().min(1) })).default([]),
    toc: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })).optional(),
  }),
});

export const collections = { changelog, docs, guides };
