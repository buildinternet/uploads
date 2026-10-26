import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteD1, database } from "../../test/helpers/sqlite-d1";
import { respondError } from "../error-response";
import { agentModelOptions } from "../openrouter-models";
import { SLACK_AGENT_DEFAULT_MODEL } from "../platform-settings";
import { adminUi } from "./admin-ui";

const ADMIN_USER = { id: "u-admin", email: "admin@b.com", name: "Admin", role: "admin" };
const NON_ADMIN_USER = { id: "u-plain", email: "plain@b.com", name: "Plain", role: "user" };

function stubAuth(user: typeof ADMIN_USER | null): Pick<Fetcher, "fetch"> {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (new URL(req.url).pathname === "/api/auth/get-session") {
        return Response.json(user ? { session: {}, user } : null);
      }
      return new Response(null, { status: 404 });
    }) as Fetcher["fetch"],
  };
}

const app = () =>
  new Hono<{ Bindings: Env }>()
    .route("/admin-ui", adminUi)
    .onError((err, c) => respondError(c, err));

let sqlite: SqliteD1 | null = null;
afterEach(() => {
  sqlite?.close();
  sqlite = null;
  vi.unstubAllGlobals();
});

function env(user: typeof ADMIN_USER | null = ADMIN_USER) {
  sqlite ??= new SqliteD1(["migrations/20261019210000_platform_settings.sql"]);
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
  };
  return { AUTH: stubAuth(user), DB: database(sqlite), REGISTRY: kv } as unknown as Env;
}

const patch = (body: unknown, e = env()) =>
  app().request(
    "/admin-ui/models/slack-agent",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    e,
  );

describe("/admin-ui/models/slack-agent", () => {
  it("starts on the default, stores a pick with who made it, and resets", async () => {
    const e = env();
    const first = await (await app().request("/admin-ui/models/slack-agent", {}, e)).json();
    expect(first).toMatchObject({ model: SLACK_AGENT_DEFAULT_MODEL, isDefault: true });

    const set = await (await patch({ model: " openai/gpt-6-luna " }, e)).json();
    expect(set).toMatchObject({ model: "openai/gpt-6-luna", isDefault: false, updatedBy: "Admin" });
    const row = sqlite!.db.prepare("SELECT key, value FROM platform_settings").all();
    expect(row).toEqual([{ key: "slack_agent_model", value: "openai/gpt-6-luna" }]);

    // Picking the default (or null) removes the row.
    expect(await (await patch({ model: SLACK_AGENT_DEFAULT_MODEL }, e)).json()).toMatchObject({
      isDefault: true,
    });
    await patch({ model: "openai/gpt-6-luna" }, e);
    await patch({ model: null }, e);
    expect(sqlite!.db.prepare("SELECT * FROM platform_settings").all()).toEqual([]);
  });

  it("rejects anything that isn't a model id, and non-admins", async () => {
    for (const model of ["", "gpt", "a/b c", 7, "../x/y"]) {
      expect((await patch({ model })).status, String(model)).toBe(400);
    }
    expect((await patch({ model: "a/b" }, env(NON_ADMIN_USER))).status).toBe(403);
  });
});

describe("agent model options", () => {
  it("keeps image + tool models, priced per million, cheapest first", () => {
    const options = agentModelOptions({
      data: [
        {
          id: "anthropic/claude-haiku-5.5",
          name: "Claude Haiku 5.5",
          pricing: { prompt: "0.000001", completion: "0.000005" },
          architecture: { input_modalities: ["text", "image"] },
          supported_parameters: ["tools", "tool_choice"],
        },
        {
          id: "cheap/vision",
          name: "Cheap",
          pricing: { prompt: "0.0000001", completion: "0.0000004" },
          architecture: { input_modalities: ["image", "text"] },
          supported_parameters: ["tools"],
        },
        {
          id: "text/only",
          architecture: { input_modalities: ["text"] },
          supported_parameters: ["tools"],
        },
        {
          id: "no/tools",
          architecture: { input_modalities: ["image"] },
          supported_parameters: [],
        },
      ],
    });
    expect(options).toEqual([
      { id: "cheap/vision", name: "Cheap", inputPerMillion: 0.1, outputPerMillion: 0.4 },
      {
        id: "anthropic/claude-haiku-5.5",
        name: "Claude Haiku 5.5",
        inputPerMillion: 1,
        outputPerMillion: 5,
      },
    ]);
  });

  it("serves the list through the admin route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: [] })),
    );
    const res = await app().request("/admin-ui/models/agent-options", {}, env());
    expect(await res.json()).toEqual([]);
  });
});
