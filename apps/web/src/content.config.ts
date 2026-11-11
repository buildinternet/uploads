import { glob } from "astro/loaders";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
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
 * Docs and guides, served by Starlight. One .mdx per page under
 * src/content/docs/: `docs/<slug>.mdx` renders at /docs/<slug> and
 * `guides/<slug>.mdx` at /guides/<slug>. Starlight owns routing, drafts, and
 * search; our overrides in src/components/starlight/ draw the chrome, and the
 * left nav and prev/next chain derive from the frontmatter below
 * (lib/docs-nav.ts).
 *
 * The hub (/docs) and the agent walkthrough (/github-screenshots) stay .astro
 * pages rendered through <StarlightPage>: they are card indexes and long-form
 * pages, not prose.
 *
 * Guides are problem-first pages ("attach a PDF to a PR from the CLI") where
 * docs pages are feature-first. `draft: true` (Starlight's own field) keeps a
 * page out of production builds while `pnpm dev` still renders it.
 */
const docs = defineCollection({
  loader: docsLoader(),
  schema: docsSchema({
    extend: z.object({
      /** The <h1> shown above the article (`title` stays the <title>). */
      heading: z.string().min(1),
      /** One-line subtitle under the <h1>. */
      tagline: z.string().min(1),
      /** Sidebar label — often shorter than `heading`. */
      navLabel: z.string().min(1),
      /** Stable key for docs.json aliases. Docs pages only. */
      navSlug: z.string().min(1).optional(),
      /** Sidebar order and the prev/next chain within docs or guides. Lower comes first. */
      navOrder: z.number().int().positive(),
      /**
       * Sidebar section, docs pages only (guides always sit under "Guides").
       * Keep `navOrder` grouped to match, so prev/next walks one section
       * before the next. Section order lives in lib/docs-nav.ts.
       */
      navGroup: z.enum(["start", "media", "github", "workspace"]).optional(),
      /**
       * Optional "on this page" rail, keyed to the page's `<section id>`s so
       * existing deep links keep working. Omit it and the rail is not rendered.
       */
      toc: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })).optional(),
      /** og:type. Defaults to "article" for guides and "website" otherwise. */
      ogType: z.enum(["website", "article"]).optional(),
      /** Guides: rendered as an on-page FAQ and as FAQPage JSON-LD. */
      faq: z.array(z.object({ q: z.string().min(1), a: z.string().min(1) })).default([]),
    }),
  }),
});

export const collections = { changelog, docs };
