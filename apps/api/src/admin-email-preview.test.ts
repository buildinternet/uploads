import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  EMAIL_PREVIEW_TYPES,
  isEmailPreviewType,
  resolvePreviewRecipient,
} from "./admin-email-preview";
import { respondError } from "./error-response";
import { adminUi } from "./routes/admin-ui";

const ADMIN = { id: "u-admin", email: "admin@example.com", name: "Admin", role: "admin" };
const USER = { id: "u-plain", email: "plain@example.com", name: "Plain", role: "user" };

function stubAuth(user: typeof ADMIN | null): Pick<Fetcher, "fetch"> {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (new URL(req.url).pathname === "/api/auth/get-session") {
        return Response.json(user ? { session: {}, user } : null);
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

function envWith(user: typeof ADMIN | null, extra: Partial<Env> = {}): Env {
  return { AUTH: stubAuth(user), WEB_ORIGIN: "https://uploads.sh", ...extra } as unknown as Env;
}

describe("preview helpers", () => {
  it("validates type ids and recipients", () => {
    expect(isEmailPreviewType("magic-link")).toBe(true);
    expect(isEmailPreviewType("nope")).toBe(false);
    expect(resolvePreviewRecipient("admin@example.com", undefined)).toBe("admin@example.com");
    expect(resolvePreviewRecipient("admin@example.com", "other@gmail.com")).toBe("other@gmail.com");
    expect(() => resolvePreviewRecipient("admin@example.com", "bad")).toThrow(/invalid recipient/i);
  });
});

describe("POST /admin-ui/dev/emails/:type", () => {
  it("gates auth and unknown types", async () => {
    expect(
      (await app().request("/admin-ui/dev/emails/magic-link", { method: "POST" }, envWith(null)))
        .status,
    ).toBe(401);
    expect(
      (await app().request("/admin-ui/dev/emails/magic-link", { method: "POST" }, envWith(USER)))
        .status,
    ).toBe(403);
    expect(
      (await app().request("/admin-ui/dev/emails/not-a-type", { method: "POST" }, envWith(ADMIN)))
        .status,
    ).toBe(400);
  });

  it("503s without EMAIL and sends each type when bound", async () => {
    const missing = await app().request(
      "/admin-ui/dev/emails/magic-link",
      { method: "POST" },
      envWith(ADMIN),
    );
    expect(missing.status).toBe(503);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      "email_not_configured",
    );

    const sent: { to: string }[] = [];
    const send = vi.fn(async (msg: { to: string }) => {
      sent.push(msg);
      return { messageId: "test" };
    });
    const env = envWith(ADMIN, { EMAIL: { send } } as unknown as Env);

    for (const preview of EMAIL_PREVIEW_TYPES) {
      sent.length = 0;
      const res = await app().request(
        `/admin-ui/dev/emails/${preview.id}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        to: "admin@example.com",
        type: preview.id,
      });
      expect(sent).toEqual([{ to: "admin@example.com" }]);
    }

    sent.length = 0;
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
    expect(sent[0]?.to).toBe("schema.whitelisting+sample@gmail.com");
  });
});

describe("GET /admin-ui/dev/emails", () => {
  it("lists types for admins", async () => {
    const res = await app().request("/admin-ui/dev/emails", {}, envWith(ADMIN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { types: { id: string }[] };
    expect(body.types.map((t) => t.id)).toEqual(EMAIL_PREVIEW_TYPES.map((t) => t.id));
  });
});
