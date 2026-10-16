// Homepage SEO copy: the meta description, the hero "best for" line, and the
// FAQ. Answers are the source for both the server-rendered accordion and the
// FAQPage JSON-LD, so the two cannot drift. Numbers come from the plan catalog
// (the same source as /docs/limits). Rate-limit ceilings stay qualitative:
// the public docs treat them as internal fair-use guards, not marketed quotas.
import { PLAN_FACTS } from "./plan-facts";

export const HOME_DESCRIPTION =
  "Attach screenshots, recordings, and test reports to GitHub PRs from Claude Code, Codex, or CI. Stable public URLs, one auto-updating PR comment.";

export const HOME_BEST_FOR =
  "Best for agents and CI jobs that need screenshots in a pull request, even where gh can't attach files (GitHub App tokens, Claude Code cloud sessions). Free to start, no bucket needed.";

const REPO = "https://github.com/buildinternet/uploads";
const SELF_HOST_DOCS =
  "https://github.com/buildinternet/uploads/blob/main/docs/ops.md#minimal-binding-profile-self-hosting-uploads754-item-3";

export type HomeFaqSpan = {
  text: string;
  href?: string;
  code?: boolean;
};

export type HomeFaqItem = {
  q: string;
  paragraphs: HomeFaqSpan[][];
};

export const HOME_FAQ: HomeFaqItem[] = [
  {
    q: "How do I attach a screenshot to a GitHub PR from Claude Code?",
    paragraphs: [
      [
        { text: "Install the CLI with " },
        { text: "npm install -g @buildinternet/uploads", code: true },
        { text: ". Sign in with " },
        { text: "uploads login", code: true },
        { text: ", then run " },
        { text: "uploads install", code: true },
        { text: " so Claude Code, Codex, and CI know the commands." },
      ],
      [
        { text: "On your branch, run " },
        { text: "uploads put ./screenshot.png", code: true },
        {
          text: ". The file gets a stable public URL immediately. When the pull request opens, staged files land in one attachments comment, and that comment updates when you upload again.",
        },
      ],
      [
        { text: "A pull request that is already open takes " },
        { text: "uploads attach ./screenshot.png", code: true },
        { text: ". A Claude Code cloud session with no local shell uses the " },
        { text: "hosted MCP server", href: "/guides/cloud-agent-screenshots" },
        { text: " at " },
        { text: "agents.uploads.sh", code: true },
        { text: "." },
      ],
    ],
  },
  {
    q: "Why does gh have no attachment upload for a GitHub App token?",
    paragraphs: [
      [
        {
          text: "People still search for “gh has no attachment upload” because GitHub has no public API for attachments. The website can attach a file in the editor.",
        },
      ],
      [
        {
          text: "Since September 2026, gh 2.99 can attach images and video to an existing issue or pull request. That upload accepts an OAuth token from gh auth login, or a classic personal access token, and the file has to be on that machine.",
        },
      ],
      [
        {
          text: "A GitHub App token or installation token cannot upload an attachment. Claude Code cloud sessions and most CI jobs run with one of those tokens, or with no gh login at all, so they cannot either.",
        },
      ],
      [
        {
          text: "Uploads hosts the file and posts one comment on the PR, so those runs can still attach screenshots to a PR.",
        },
      ],
    ],
  },
  {
    q: "Does it work before the PR exists?",
    paragraphs: [
      [
        { text: "Yes. On any branch other than the default, " },
        { text: "uploads put", code: true },
        { text: " and " },
        { text: "uploads screenshot", code: true },
        {
          text: " stage the file for that branch. The file is hosted right away.",
        },
      ],
      [
        { text: "When a pull request opens, the " },
        { text: "uploads GitHub App", href: "/docs/github-app#staging" },
        { text: " promotes the staged files into the PR comment." },
      ],
      [
        { text: "Without the App, run " },
        { text: "uploads attach --promote", code: true },
        { text: " once the PR exists." },
      ],
      [
        {
          text: "A file staged more than 30 days before the PR opens stays hosted. It does not promote on its own.",
        },
      ],
    ],
  },
  {
    q: "Do I need to pay, or bring my own bucket?",
    paragraphs: [
      [
        {
          text: `No. A new workspace starts on the ${PLAN_FACTS.freeName} plan: ${PLAN_FACTS.freeStorage} of hosted storage and files up to ${PLAN_FACTS.freeMaxUpload}. That holds thousands of screenshots, so you can start with no bucket of your own.`,
        },
      ],
      [
        {
          text: `${PLAN_FACTS.proName} is for a workspace that outgrows ${PLAN_FACTS.freeName}: ${PLAN_FACTS.proStorage} of storage and files up to ${PLAN_FACTS.proMaxUpload}. See `,
        },
        { text: "plans and limits", href: "/docs/limits" },
        { text: "." },
      ],
      [
        { text: "Bring your own bucket", href: "/docs/byo-bucket" },
        {
          text: " when you want storage you already pay for. Cloudflare R2, Amazon S3, Backblaze B2, MinIO, and other S3-compatible stores all work. Storage on your bucket is unmetered.",
        },
      ],
      [
        {
          text: "File-size caps still apply, and Uploads stays in the path under fair-use API limits. Normal agent and CI use does not reach those limits.",
        },
      ],
    ],
  },
  {
    q: "Is it open source, and can I self-host it?",
    paragraphs: [
      [
        {
          text: "Yes. The CLI and the service are open source under the Apache 2.0 license. ",
        },
        { text: "Read the source on GitHub", href: REPO },
        { text: "." },
      ],
      [
        { text: "Self-host from the " },
        { text: "operator runbook", href: SELF_HOST_DOCS },
        {
          text: ". A self-hosted deploy sets its own storage limits. The hosted service is free to start.",
        },
      ],
    ],
  },
  {
    q: "Does it work with private repos?",
    paragraphs: [
      [
        { text: "Yes. Install the " },
        { text: "uploads GitHub App", href: "/docs/github-app" },
        {
          text: " on the private repository and it can post the attachments comment.",
        },
      ],
      [
        {
          text: "Anyone with the file URL can still fetch the file, including a file attached to a private repo. When the App can see that the repo is private, new attachment URLs use an unguessable prefix, so they are not derived from the repository name.",
        },
      ],
      [
        { text: "Leave secrets out of the capture, or redact them with " },
        { text: "uploads annotate", code: true },
        { text: "." },
      ],
    ],
  },
];

/** Visible answer text, in order, for JSON-LD and tests. */
export function homeFaqPlainText(item: HomeFaqItem): string {
  return item.paragraphs.map((paragraph) => paragraph.map((span) => span.text).join("")).join(" ");
}

export function homeFaqJsonLd(items: HomeFaqItem[] = HOME_FAQ): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: homeFaqPlainText(item),
      },
    })),
  });
}
