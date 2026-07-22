import { escapeHtml, renderEmailCard, strong, type RenderedEmail } from "./card";

const GITHUB_APP = "https://github.com/apps/uploads-sh";
const REPO = "https://github.com/buildinternet/uploads";

const MONO = "ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace";
const FG = "#ececea";

function code(value: string): string {
  return `<code style="font-family:${MONO};font-size:13px;color:${FG};">${escapeHtml(value)}</code>`;
}

function link(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="color:${FG};text-decoration:underline;">${escapeHtml(label)}</a>`;
}

function step(n: number, title: string, detailHtml: string): string {
  return `<strong style="color:${FG};font-weight:600;">${n}. ${escapeHtml(title)}</strong><br>${detailHtml}`;
}

/**
 * First-membership welcome: keep momentum with install, GitHub App, docs, star.
 */
export function renderWelcomeEmail(ctx: {
  workspaceName?: string;
  webOrigin?: string;
}): RenderedEmail {
  const origin = (ctx.webOrigin || "https://uploads.sh").replace(/\/$/, "");
  const docsUrl = `${origin}/docs`;
  const workspace = ctx.workspaceName?.trim();
  const where = workspace ? `You're on ${strong(workspace)}.` : "Your uploads.sh account is ready.";
  const whereText = workspace ? `You're on ${workspace}.` : "Your uploads.sh account is ready.";

  const bodyHtml = [
    `${where} A few next steps:`,
    "<br><br>",
    step(1, "Wire your agent", `Run ${code("uploads install")} — skills + the hosted MCP server.`),
    "<br><br>",
    step(
      2,
      "Install the GitHub App",
      `${link(GITHUB_APP, "github.com/apps/uploads-sh")} on repos you attach to — bot comments and live PR titles.`,
    ),
    "<br><br>",
    step(
      3,
      "Skim the docs",
      `${link(docsUrl, "uploads.sh/docs")} when you need a command or flag.`,
    ),
    "<br><br>",
    step(
      4,
      "Star the repo",
      `${link(REPO, "github.com/buildinternet/uploads")} — helps others find it.`,
    ),
  ].join("");

  return renderEmailCard({
    subject: "Welcome to uploads.sh",
    preheader: "Next: uploads install, the GitHub App, docs — and a star if you like it.",
    eyebrow: "Welcome",
    title: "You're in",
    bodyHtml,
    text: [
      "Welcome to uploads.sh",
      "",
      whereText,
      "A few next steps:",
      "",
      "1. Wire your agent",
      "   uploads install",
      "",
      "2. Install the GitHub App",
      `   ${GITHUB_APP}`,
      "",
      "3. Skim the docs",
      `   ${docsUrl}`,
      "",
      "4. Star the repo (helps others find it)",
      `   ${REPO}`,
      "",
      "—",
      "uploads.sh · a Build Internet project",
    ].join("\n"),
    cta: { url: docsUrl, label: "Open the docs →" },
    footNoteHtml: "Already set up? You can ignore this — it's just a nudge.",
    webOrigin: origin,
  });
}
