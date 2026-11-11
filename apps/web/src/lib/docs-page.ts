// Page data for the Starlight overrides in components/starlight/.
//
// Collection pages (src/content/docs/**) carry our extra frontmatter
// (`heading`, `tagline`, `toc`, …) on `starlightRoute.entry.data`. The two
// .astro pages rendered through <StarlightPage> (the /docs hub and the agent
// walkthrough) can't: StarlightPage validates its `frontmatter` prop against
// the user schema by importing content.config.ts at render time, and that
// import fails inside the Cloudflare prerender bundle, so Starlight silently
// falls back to its default schema and strips our fields. DocsPage.astro
// stashes them on `Astro.locals` instead, and the overrides read through here.

export interface DocsPageExtras {
  heading: string;
  tagline: string;
  toc?: { id: string; label: string }[];
  ogType?: "website" | "article";
}

type Locals = App.Locals & { docsPage?: DocsPageExtras };

export function setDocsPageExtras(locals: App.Locals, extras: DocsPageExtras): void {
  (locals as Locals).docsPage = extras;
}

/** Entry frontmatter merged with any extras a <DocsPage> set. */
export function getDocsPageData(locals: App.Locals) {
  const data = locals.starlightRoute.entry.data;
  const extras = (locals as Locals).docsPage;
  return {
    ...data,
    ...extras,
    heading: extras?.heading ?? data.heading ?? data.title,
    tagline: extras?.tagline ?? data.tagline ?? "",
    faq: data.faq ?? [],
    head: data.head ?? [],
  };
}
