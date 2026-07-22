import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  EMAIL_PREVIEW_TYPES,
  isEmailPreviewType,
  resolvePreviewRecipient,
} from "./admin-email-preview";
import { respondError } from "./error-response";
import { adminUi } from "./routes/admin-ui";

const ADMIN_USER = { id: "u-admin", email: "admin@example.com", name: "Admin", role: "admin" };
const NON_ADMIN = { id: "u-plain", email: "plain@example.com", name: "Plain", role: "user" };

function stubAuth(user: typeof ADMIN_USER | null): Pick<Fetcher, "fetch"> {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === "/api/auth/get-session") {
        return new Response(JSON.stringify(user ? { session: {}, user } : null), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as Fetcher["fetch"],
  };
}

function app() {
  return new Hono<{ Bindings: Env }>()
    .route("/admin-ui", adminUi)
    .onError((err, c) => respondError(c, err));
}

describe("email preview helpers", () => {
  it("recognizes known types only", () => {
    expect(isEmailPreviewType("magic-link")).toBe(true);
    expect(isEmailPreviewType("not-a-type")).toBe(false);
  });

  it("defaults the recipient to the session email", () => {
    expect(resolvePreviewRecipient("admin@example.com", undefined)).toBe("admin@example.com");
  });

  it("accepts an explicit recipient override", () => {
    expect(resolvePreviewRecipient("admin@example.com", "other@gmail.com")).toBe("other@gmail.com");
  });

  it("rejects a bad recipient override", () => {
    expect(() => resolvePreviewRecipient("admin@example.com", "not-an-email")).toThrow(
      /invalid recipient/i,
    );
  });
});

describe("GET /admin-ui/dev/emails", () => {
  it("lists preview types for admins", async () => {
    const env = { AUTH: stubAuth(ADMIN_USER) } as unknown as Env;
    const res = await app().request("/admin-ui/dev/emails", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { types: typeof EMAIL_PREVIEW_TYPES };
    expect(body.types.map((t) => t.id)).toEqual(EMAIL_PREVIEW_TYPES.map((t) => t.id));
  });

  it("401s without a session", async () => {
    const env = { AUTH: stubAuth(null) } as unknown as Env;
    const res = await app().request("/admin-ui/dev/emails", {}, env);
    expect(res.status).toBe(401);
  });
});

describe("POST /admin-ui/dev/emails/:type", () => {
  it("rejects unknown types", async () => {
    const env = { AUTH: stubAuth(ADMIN_USER) } as unknown as Env;
    const res = await app().request("/admin-ui/dev/emails/not-a-type", { method: "POST" }, env);
    expect(res.status).toBe(400);
  });

  it("403s for non-admins", async () => {
    const env = { AUTH: stubAuth(NON_ADMIN) } as unknown as Env;
    const res = await app().request("/admin-ui/dev/emails/magic-link", { method: "POST" }, env);
    expect(res.status).toBe(403);
  });

  it("503s when EMAIL is not bound", async () => {
    const env = { AUTH: stubAuth(ADMIN_USER), WEB_ORIGIN: "https://uploads.sh" } as unknown as Env;
    const res = await app().request("/admin-ui/dev/emails/magic-link", { method: "POST" }, env);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("email_not_configured");
  });

  it("sends each preview type to the signed-in admin", async () => {
    const sent: { to: string; subject: string; from: { email: string }; html?: string }[] = [];
    const email = {
      send: vi.fn(
        async (msg: { to: string; subject: string; from: { email: string }; html?: string }) => {
          sent.push(msg);
          return { messageId: "test" };
        },
      ),
    };
    const env = {
      AUTH: stubAuth(ADMIN_USER),
      EMAIL: email,
      WEB_ORIGIN: "https://uploads.sh",
    } as unknown as Env;

    for (const preview of EMAIL_PREVIEW_TYPES) {
      sent.length = 0;
      const res = await app().request(
        `/admin-ui/dev/emails/${preview.id}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; to: string; type: string; subject: string };
      expect(body).toMatchObject({ ok: true, to: "admin@example.com", type: preview.id });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.to).toBe("admin@example.com");
      expect(sent[0]?.html).toContain("<!doctype html>");
      // CTA emails embed Gmail ViewAction; member-joined is notification-only.
      if (preview.id === "member-joined") {
        expect(sent[0]?.html).not.toContain("ViewAction");
      } else {
        expect(sent[0]?.html).toContain("ViewAction");
      }
    }
  });

  it("honors an explicit to address", async () => {
    const email = {
      send: vi.fn(async () => ({ messageId: "test" })),
    };
    const env = {
      AUTH: stubAuth(ADMIN_USER),
      EMAIL: email,
      WEB_ORIGIN: "https://uploads.sh",
    } as unknown as Env;
    const res = await app().request(
      "/admin-ui/dev/emails/magic-link",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "schema.whitelisting+sample@gmail.com" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: "schema.whitelisting+sample@gmail.com" }),
    );
  });
});
