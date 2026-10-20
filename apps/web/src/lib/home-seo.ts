// Homepage SEO copy: the meta description, the hero "best for" line, and the
// FAQ. Each answer is one HTML string. The accordion renders it, and the
// FAQPage JSON-LD uses the same string with the tags removed. Numbers come
// from the plan catalog (the same source as /docs/limits). Rate-limit
// ceilings stay qualitative: the public docs treat them as internal fair-use
// guards, not marketed quotas.
import { PLAN_FACTS } from "./plan-facts";

export const HOME_DESCRIPTION =
  "Attach screenshots, recordings, and test reports to GitHub PRs from Claude Code, Codex, or CI. Stable public URLs, one auto-updating PR comment.";

export const HOME_BEST_FOR =
  "Best for agents and CI jobs that need screenshots in a pull request, even where gh can't attach files (GitHub App tokens, Claude Code cloud sessions). Free to start, no bucket needed.";

const REPO = "https://github.com/buildinternet/uploads";
const SELF_HOST_DOCS =
  "https://github.com/buildinternet/uploads/blob/main/docs/ops.md#minimal-binding-profile-self-hosting-uploads754-item-3";

export type HomeFaqItem = {
  q: string;
  /** HTML rendered in the accordion. JSON-LD is this string with the tags removed. */
  a: string;
};

export const HOME_FAQ: HomeFaqItem[] = [
  {
    q: "How do I attach a screenshot to a GitHub PR from Claude Code?",
    a: `<p>Install the CLI with <code>npm install -g @buildinternet/uploads</code>. Sign in with <code>uploads login</code>, then run <code>uploads install</code> so Claude Code, Codex, and CI know the commands.</p>
<p>On your branch, run <code>uploads put ./screenshot.png</code>. The file gets a stable public URL immediately. When the pull request opens, staged files land in one attachments comment, and that comment updates when you upload again.</p>
<p>A pull request that is already open takes <code>uploads attach ./screenshot.png</code>. A Claude Code cloud session with no local shell uses the <a href="/guides/cloud-agent-screenshots">hosted MCP server</a> at <code>agents.uploads.sh</code>.</p>`,
  },
  {
    q: "Why does gh have no attachment upload for a GitHub App token?",
    a: `<p>People still search for “gh has no attachment upload” because GitHub has no public API for attachments.</p>
<p>A GitHub App token, an installation token, or a Claude Code cloud session cannot upload an attachment.</p>
<p>Uploads hosts the file and posts one comment on the pull request.</p>`,
  },
  {
    q: "Does it work before the PR exists?",
    a: `<p>Yes. On any branch other than the default, <code>uploads put</code> and <code>uploads screenshot</code> stage the file for that branch. The file is hosted right away.</p>
<p>When a pull request opens, the <a href="/docs/github-app#staging">uploads GitHub App</a> promotes the staged files into the PR comment.</p>
<p>Without the App, run <code>uploads attach --promote</code> once the PR exists.</p>
<p>A file staged more than 30 days before the PR opens stays hosted. It does not promote on its own.</p>`,
  },
  {
    q: "Can I require screenshots on pull requests?",
    a: `<p>Yes. The <a href="/docs/github-app">uploads GitHub App</a> adds a check called <code>uploads.sh</code> to pull requests that change UI files. Turn on <strong>Require screenshots on UI changes</strong> in workspace Settings, or add <code>check.require</code> to <code>.uploads.yml</code>, and the check fails until the PR has a screenshot or recording.</p>
<p>Make it a required check in GitHub branch protection to block merges. Images dragged into the PR on GitHub count too. See <a href="/docs/require-screenshots">Require screenshots on pull requests</a>.</p>`,
  },
  {
    q: "Do I need to pay, or bring my own bucket?",
    a: `<p>No. A new workspace starts on the ${PLAN_FACTS.freeName} plan: ${PLAN_FACTS.freeStorage} of hosted storage and files up to ${PLAN_FACTS.freeMaxUpload}. That holds hundreds of screenshots, so you can start with no bucket of your own.</p>
<p>${PLAN_FACTS.proName} is for a workspace that outgrows ${PLAN_FACTS.freeName}: ${PLAN_FACTS.proStorage} of storage and files up to ${PLAN_FACTS.proMaxUpload}. See <a href="/docs/limits">plans and limits</a>.</p>
<p><a href="/docs/byo-bucket">Bring your own bucket</a> when you want storage you already pay for. Cloudflare R2, Amazon S3, Backblaze B2, MinIO, and other S3-compatible stores all work. Storage on your bucket is unmetered.</p>
<p>File-size caps still apply, and Uploads stays in the path under fair-use API limits. Normal agent and CI use does not reach those limits.</p>`,
  },
  {
    q: "Is it open source, and can I self-host it?",
    a: `<p>Yes. The CLI and the service are open source under the Apache 2.0 license. <a href="${REPO}">Read the source on GitHub</a>.</p>
<p>Self-host from the <a href="${SELF_HOST_DOCS}">operator runbook</a>. A self-hosted deploy sets its own storage limits. The hosted service is free to start.</p>`,
  },
  {
    q: "Does it work with private repos?",
    a: `<p>Yes. Install the <a href="/docs/github-app">uploads GitHub App</a> on the private repository and it can post the attachments comment.</p>
<p>Anyone with the file URL can still fetch the file, including a file attached to a private repo. When the App can see that the repo is private, new attachment URLs use an unguessable prefix, so they are not derived from the repository name.</p>
<p>Leave secrets out of the capture, or redact them with <code>uploads annotate</code>.</p>`,
  },
];

function faqAnswerText(html: string): string {
  return html
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll(/\s+/g, " ")
    .trim();
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
        text: faqAnswerText(item.a),
      },
    })),
  });
}
