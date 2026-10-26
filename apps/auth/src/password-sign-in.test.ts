import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vitest";
import type { AuthEnv } from "./auth";
import { app } from "./index";
import * as schema from "./schema";
import { createFakeD1 } from "./test/fake-d1";

function passwordEnv() {
  const send = vi.fn(async (_message: { to: string; text?: string }) => undefined);
  const env: AuthEnv = {
    DB: createFakeD1(),
    WEB_ORIGIN: "https://uploads.sh",
    BETTER_AUTH_URL: "https://uploads.sh",
    ENVIRONMENT: "development",
    BETTER_AUTH_SECRET: "test-signing-secret-at-least-32-chars-long",
    EMAIL: { send },
  };
  return { env, send };
}

async function seedUser(env: AuthEnv, emailVerified: boolean): Promise<string> {
  const id = crypto.randomUUID();
  const email = `${id}@example.com`;
  await drizzle(env.DB, { schema }).insert(schema.user).values({
    id,
    name: "Password test",
    email,
    emailVerified,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return email;
}

function post(env: AuthEnv, path: string, body: unknown) {
  return app.request(
    `/api/auth${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://uploads.sh" },
      body: JSON.stringify(body),
    },
    env,
  );
}

/** Request a reset email and set `password` through its token. */
async function setPasswordByEmail(
  env: AuthEnv,
  send: ReturnType<typeof passwordEnv>["send"],
  email: string,
  password: string,
) {
  const requested = await post(env, "/request-password-reset", {
    email,
    redirectTo: "https://uploads.sh/reset-password",
  });
  expect(requested.status).toBe(200);
  await vi.waitFor(() => expect(send).toHaveBeenCalled());
  const message = send.mock.calls.at(-1)![0];
  expect(message.to).toBe(email);
  const token = message.text?.match(/\/reset-password\/([^?\s]+)/)?.[1];
  expect(token).toBeTruthy();
  return post(env, "/reset-password", { token, newPassword: password });
}

describe("password sign-in", () => {
  it("does not allow password sign-up", async () => {
    const { env } = passwordEnv();
    const res = await post(env, "/sign-up/email", {
      email: "new@example.com",
      password: "a-long-enough-password",
      name: "New",
    });
    expect(res.ok).toBe(false);
  });

  it("sets a password through the emailed link, then signs in with it", async () => {
    const { env, send } = passwordEnv();
    const email = await seedUser(env, true);
    const reset = await setPasswordByEmail(env, send, email, "a-long-enough-password");
    expect(reset.status).toBe(200);

    const signIn = await post(env, "/sign-in/email", { email, password: "a-long-enough-password" });
    expect(signIn.status).toBe(200);
    expect(signIn.headers.get("set-cookie")).toMatch(/session_token=/);

    const wrong = await post(env, "/sign-in/email", { email, password: "not-the-password" });
    expect(wrong.status).toBe(401);
  });

  it("refuses password sign-in until the email is verified", async () => {
    const { env, send } = passwordEnv();
    const email = await seedUser(env, false);
    expect((await setPasswordByEmail(env, send, email, "a-long-enough-password")).status).toBe(200);

    const signIn = await post(env, "/sign-in/email", { email, password: "a-long-enough-password" });
    expect(signIn.status).toBe(403);
    expect(signIn.headers.get("set-cookie") ?? "").not.toMatch(/session_token=/);
  });

  it("rejects passwords shorter than 12 characters", async () => {
    const { env, send } = passwordEnv();
    const email = await seedUser(env, true);
    const reset = await setPasswordByEmail(env, send, email, "short-pass");
    expect(reset.status).toBe(400);
  });
});
