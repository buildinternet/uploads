/**
 * Live GitHub star count for SiteHeader (1h localStorage).
 * Lives in a .ts module so SiteHeader.astro can keep the script behind the
 * `star` guard without prettier-plugin-astro choking on function bodies inside
 * a JSX-conditional `<script>` (issue #551).
 */
import { onAstroPageLoad } from "../lib/account-shell";

const STARS_KEY = "gh-stars";
const STARS_TTL_MS = 3_600_000;

function formatStars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

async function fillStarCount(): Promise<void> {
  const el = document.getElementById("star-count");
  if (!el) return;
  const paint = (n: number) => {
    if (document.contains(el)) el.textContent = formatStars(n);
  };
  try {
    const cached = JSON.parse(localStorage.getItem(STARS_KEY) ?? "null") as {
      t?: number;
      n?: number;
    } | null;
    if (cached && typeof cached.n === "number" && Date.now() - (cached.t ?? 0) < STARS_TTL_MS) {
      paint(cached.n);
      return;
    }
    const res = await fetch("https://api.github.com/repos/buildinternet/uploads");
    if (!res.ok) return;
    const n = ((await res.json()) as { stargazers_count?: unknown }).stargazers_count;
    if (typeof n !== "number") return;
    localStorage.setItem(STARS_KEY, JSON.stringify({ t: Date.now(), n }));
    paint(n);
  } catch {
    /* count stays empty — the CTA still works */
  }
}

// Module scripts run once per session — re-fill after ClientRouter swaps;
// eager boot covers non-router pages.
void fillStarCount();
onAstroPageLoad(() => void fillStarCount());
