/**
 * /docs.json — catalog of public docs pages. Prerendered at build time and
 * served off the ASSETS binding; headers come from public/_headers. The CLI
 * (`uploads docs`) and MCP `search_docs` tool read this.
 */
import type { APIRoute } from "astro";
import { aliasesFor, renderDocsCatalog } from "../lib/docs-catalog";
import { DOCS_HUB, getOrderedDocs } from "../lib/docs-nav";

export const prerender = true;

export const GET: APIRoute = async () => {
  const entries = await getOrderedDocs();
  const pages = [
    {
      page: "docs",
      path: DOCS_HUB.href,
      title: "Docs",
      summary:
        "Install the uploads CLI, attach screenshots and video to GitHub PRs, issues, and code reviews, and set up your agent. Hosted and open source.",
      aliases: aliasesFor("docs", [DOCS_HUB.slug]),
    },
    ...entries.map((entry) => ({
      page: entry.id,
      path: `/docs/${entry.id}`,
      title: entry.data.heading,
      summary: entry.data.description,
      aliases: aliasesFor(entry.id, [entry.data.navSlug]),
    })),
    {
      page: "github-screenshots",
      path: "/github-screenshots",
      title: "How to get agents to upload screenshots & video to GitHub",
      summary:
        "One command for Claude Code, CI jobs, and scripts that captures, hosts, and posts screenshots and video to PRs and issues, before or after the PR exists.",
      aliases: aliasesFor("github-screenshots", ["walkthrough"]),
    },
    {
      page: "changelog",
      path: "/changelog",
      title: "Changelog",
      summary: "Platform updates and CLI releases, newest first.",
      aliases: aliasesFor("changelog"),
    },
    {
      page: "auth",
      path: "/auth.md",
      title: "Auth for agents",
      summary: "Device sign-in, workspace bearer tokens, and hosted MCP OAuth.",
      aliases: aliasesFor("auth"),
    },
  ];
  return new Response(JSON.stringify(renderDocsCatalog(pages), null, 2) + "\n", {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
