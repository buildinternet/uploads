/**
 * Atom serializer for /changelog.xml. Entries carry full HTML content with
 * absolute image URLs so releases.sh mirrors the media at ingest.
 */
import type { ChangelogEntry } from "./changelog";

const SITE = "https://uploads.sh";
const PAGE = `${SITE}/changelog`;
const FEED = `${SITE}/changelog.xml`;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The lead image lives in frontmatter, not the body — inline it into the
 * feed content so releases.sh sees (and mirrors) it at ingest.
 */
function entryContentHtml(entry: ChangelogEntry): string {
  if (!entry.image) return entry.html;
  const escapeAttr = (v: string) => v.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<p><img src="${escapeAttr(entry.image.url)}" alt="${escapeAttr(entry.image.alt)}"></p>${entry.html}`;
}

export function renderAtomFeed(entries: ChangelogEntry[]): string {
  if (entries.length === 0) {
    throw new Error("renderAtomFeed: refusing to publish an empty feed");
  }
  const updated = entries
    .map((e) => e.date)
    .sort()
    .at(-1)!;

  const items = entries
    .map(
      (entry) => `  <entry>
    <id>${PAGE}#${entry.id}</id>
    <title>${escapeXml(entry.title)}</title>
    <link href="${PAGE}#${entry.id}"/>
    <updated>${entry.date}</updated>
${entry.tags.map((tag) => `    <category term="${escapeXml(tag)}"/>`).join("\n")}
    <content type="html">${escapeXml(entryContentHtml(entry))}</content>
  </entry>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${PAGE}</id>
  <title>uploads.sh changelog</title>
  <subtitle>Platform updates and CLI releases</subtitle>
  <link href="${PAGE}"/>
  <link href="${FEED}" rel="self"/>
  <updated>${updated}</updated>
  <author><name>uploads.sh</name></author>
${items}
</feed>
`;
}
