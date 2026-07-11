/**
 * Live agent-skills discovery handler, mounted by the Astro endpoint so skill
 * content can track GitHub `main` without a web redeploy.
 *
 * Index lives on uploads.sh; each skill `url` is an absolute raw.githubusercontent.com
 * link (Agent Skills Discovery RFC). Digest is sha256 of the bytes fetched from
 * that URL at request time.
 */
const GITHUB_REPO = "buildinternet/uploads";
/** Branch or tag that always means "latest published skill sources". */
const SKILLS_REF = "main";

/** Monorepo paths (repo root) for skills to advertise. */
const SKILL_SOURCES = ["skills/uploads-cli/SKILL.md"] as const;

const SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

function rawGithubUrl(sourceRel: string): string {
  const path = sourceRel
    .split(/[/\\]+/)
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `https://raw.githubusercontent.com/${GITHUB_REPO}/${encodeURIComponent(SKILLS_REF)}/${path}`;
}

/**
 * Minimal YAML frontmatter parse for Agent Skills SKILL.md files.
 * Supports `name: value` and folded `description: >-` / `description: |` blocks.
 */
function parseSkillFrontmatter(markdown: string): { name: string; description: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw new Error("SKILL.md is missing YAML frontmatter (--- … ---)");
  }
  const block = match[1];
  const lines = block.split(/\r?\n/);
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) {
      i += 1;
      continue;
    }
    const key = kv[1];
    const raw = kv[2];
    if (raw === ">-" || raw === ">" || raw === "|" || raw === "|-") {
      const folded = raw.startsWith(">");
      const parts: string[] = [];
      i += 1;
      while (i < lines.length && /^(?: {2}|\t)/.test(lines[i])) {
        parts.push(lines[i].replace(/^(?: {2}|\t)/, ""));
        i += 1;
      }
      fields[key] = folded ? parts.join(" ").replace(/\s+/g, " ").trim() : parts.join("\n").trim();
      continue;
    }
    fields[key] = raw.replace(/^["']|["']$/g, "").trim();
    i += 1;
  }
  if (!fields.name) throw new Error("SKILL.md frontmatter missing name");
  if (!fields.description) throw new Error("SKILL.md frontmatter missing description");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.name) || fields.name.length > 64) {
    throw new Error(`invalid skill name in frontmatter: ${fields.name}`);
  }
  if (fields.description.length > 1024) {
    throw new Error(`skill description exceeds 1024 characters: ${fields.name}`);
  }
  return { name: fields.name, description: fields.description };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type SkillEntry = {
  name: string;
  type: "skill-md";
  description: string;
  url: string;
  digest: string;
};

async function loadSkill(sourceRel: string): Promise<SkillEntry> {
  const url = rawGithubUrl(sourceRel);
  const response = await fetch(url, {
    headers: { Accept: "text/plain, text/markdown, */*" },
  });
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: HTTP ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  const text = new TextDecoder("utf-8").decode(bytes);
  const { name, description } = parseSkillFrontmatter(text);
  const digest = `sha256:${await sha256Hex(bytes)}`;
  return { name, type: "skill-md", description, url, digest };
}

async function buildIndex(): Promise<{ $schema: string; skills: SkillEntry[] }> {
  const skills = await Promise.all(SKILL_SOURCES.map((source) => loadSkill(source)));
  return { $schema: SCHEMA, skills };
}

const INDEX_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  // Short cache: skill edits on main should show up without a web deploy.
  "Cache-Control": "public, max-age=60",
  "Access-Control-Allow-Origin": "*",
} as const;

export async function handleAgentSkillsIndex(request: Request): Promise<Response> {
  // Mounted only at /.well-known/agent-skills/index.json by the Astro route.
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD, OPTIONS" },
    });
  }

  try {
    const index = await buildIndex();
    const body = `${JSON.stringify(index, null, 2)}\n`;
    if (request.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          ...INDEX_HEADERS,
          "Content-Length": String(new TextEncoder().encode(body).byteLength),
        },
      });
    }
    return new Response(body, { status: 200, headers: INDEX_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: "agent_skills_index_failed", message }));
    return new Response(
      `${JSON.stringify({ error: "agent_skills_index_unavailable", message }, null, 2)}\n`,
      {
        status: 502,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}
