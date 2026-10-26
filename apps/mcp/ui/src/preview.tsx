/** Local development only. This entrypoint is never part of the MCP resource build. */
import { createRoot } from "react-dom/client";
import type { StagedMediaItem } from "../../src/staged-media-response";
import type { TrayClient, TrayEvent } from "./client";
import { Tray } from "./tray";
import "./styles.css";

const scopes = [
  { repo: "example/studio", branch: "settings-refresh" },
  { repo: "example/studio", branch: "navigation" },
  { repo: "example/store", branch: "checkout" },
  { repo: "example/studio", branch: "empty" },
  { repo: "example/studio", branch: "error" },
  { repo: "example/studio", branch: "slow" },
];
function item(id: string, branch: string): StagedMediaItem {
  return {
    id,
    key: `fixture/${branch}/${id}.png`,
    filename: `${branch}-${id}.png`,
    mediaType: "image",
    status: id === "private" ? "withheld" : "available",
    previewUrl:
      id === "private"
        ? null
        : "https://embed.uploads.sh/default/gh/buildinternet/uploads/branch/codex-openai-ui-compatibility-spike/chatgpt-global-connected.webp",
    state: id === "before" ? "before" : "after",
    path: "/settings",
    stagedAt: "2026-10-25T12:00:00Z",
  };
}
const listeners = new Set<(event: TrayEvent) => void>();
function emit(event: TrayEvent) {
  for (const listener of listeners) listener(event);
}
function hostResult(branch: string, pr: number): TrayEvent {
  return {
    type: "result",
    result: {
      structuredContent: {
        repo: "example/studio",
        branch,
        pr,
        prResolution: "explicit",
        items: [item("before", branch)],
        cursor: null,
      },
    },
  };
}
const client: TrayClient = {
  async connect() {},
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  async callTool(name, args) {
    await new Promise((resolve) => setTimeout(resolve, args.branch === "slow" ? 2500 : 150));
    if (name === "list_staged_scopes") return { structuredContent: { scopes, cursor: null } };
    const repo = String(args.repo);
    const branch = String(args.branch);
    if (name === "resolve_media_context")
      return {
        structuredContent: {
          repo,
          branch,
          pr: branch === "empty" || branch === "feature/abc" ? null : Number(args.pr ?? 42),
          prResolution: args.pr ? "explicit" : branch === "empty" ? "unavailable" : "resolved",
        },
      };
    if (branch === "error")
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Fixture authorization failure: reconnect Uploads to read this workspace.",
          },
        ],
      };
    return {
      structuredContent: {
        repo,
        branch,
        ...(name === "list_attached_media" ? { pr: Number(args.pr) } : {}),
        items:
          branch === "empty"
            ? []
            : args.cursor
              ? [item("private", branch)]
              : name === "list_attached_media"
                ? [item("attached", branch)]
                : [item("before", branch), item("after", branch)],
        cursor: branch === "empty" || args.cursor ? null : "fixture-next-page",
      },
    };
  },
};
createRoot(document.getElementById("root")!).render(
  <>
    <p style={{ padding: "8px 20px", fontSize: 12, color: "var(--muted)" }}>
      Local fixture preview · no Uploads account connected
      {" · "}
      <button
        onClick={() => {
          emit({
            type: "input",
            scope: { repo: "example/studio", branch: "settings-refresh", pr: 1 },
          });
          emit({
            type: "input",
            scope: { repo: "example/studio", branch: "settings-refresh", pr: 2 },
          });
          setTimeout(() => emit(hostResult("settings-refresh", 1)), 50);
          setTimeout(() => emit(hostResult("settings-refresh", 2)), 100);
        }}
      >
        Host PR race
      </button>
      {" · "}
      <button
        onClick={() => {
          emit({ type: "input", scope: { repo: "example/studio", branch: "Feature/ABC" } });
          emit(hostResult("feature/abc", 42));
        }}
      >
        Mixed-case host branch
      </button>
    </p>
    <Tray client={client} />
  </>,
);
