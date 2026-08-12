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

export const collections = { changelog };
