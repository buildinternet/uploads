/**
 * JSON serializer for /changelog.json. Twin of the Atom feed: full markdown
 * bodies plus a one-paragraph summary so the CLI and agents can print recent
 * updates without scraping HTML.
 */
import { entrySummary, type ChangelogEntry } from "./changelog";

const SITE = "https://uploads.sh";
const PAGE = `${SITE}/changelog`;
const FEED = `${SITE}/changelog.xml`;

export type ChangelogJsonEntry = {
  id: string;
  kind: ChangelogEntry["kind"];
  title: string;
  date: string;
  url: string;
  tags: string[];
  summary: string;
  body: string;
};

export type ChangelogJson = {
  url: string;
  feed: string;
  entries: ChangelogJsonEntry[];
};

export function renderChangelogJson(entries: ChangelogEntry[]): ChangelogJson {
  if (entries.length === 0) {
    throw new Error("renderChangelogJson: refusing to publish an empty feed");
  }
  return {
    url: PAGE,
    feed: FEED,
    entries: entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      title: entry.title,
      date: entry.date,
      url: `${PAGE}#${entry.id}`,
      tags: entry.tags,
      summary: entrySummary(entry.markdown),
      body: entry.markdown,
    })),
  };
}
