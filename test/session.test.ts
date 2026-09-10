import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createSession, destroySession, getSessionUser, SESSION_COOKIE_NAME } from "../src/auth/session";
import type { AuthUser, Env } from "../src/env";

function testEnv(overrides: Partial<Env> = {}): Env {
  const workerEnv = env as unknown as Env;
  return {
    DB: workerEnv.DB,
    SESSIONS: workerEnv.SESSIONS,
    CACHE_BUCKET: workerEnv.CACHE_BUCKET,
    DEV_MODE: "true",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    TOKEN_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    SESSION_SECRET: "test-session-secret-with-at-least-32-chars",
    SESSION_TTL_SECONDS: "604800",
    OAUTH_STATE_TTL_SECONDS: "600",
    ...overrides
  };
}

const user: AuthUser = {
  id: "user_session",
  googleId: "google_session",
  email: "session@example.com",
  name: "Session User",
  avatarUrl: null,
  kind: "member"
};

describe("KV session cookies", () => {
  it("creates signed session cookies and reads the user back", async () => {
    const localEnv = testEnv();
    const cookie = await createSession(localEnv, user);

    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=v1.`);
    expect(cookie).toContain("Max-Age=604800");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");

    const request = new Request("http://localhost/auth/me", {
      headers: { Cookie: cookie }
    });

    await expect(getSessionUser(request, localEnv)).resolves.toEqual(user);
  });

  it("never sets a Domain attribute on the host-only cookie", async () => {
    const cookie = await createSession(testEnv({ DEV_MODE: "false" }), user);

    expect(cookie).toContain("Secure");
    expect(cookie).not.toContain("Domain=");
  });

  it("rejects tampered cookies", async () => {
    const localEnv = testEnv();
    const cookie = await createSession(localEnv, user);
    const tampered = cookie.replace("v1.", "v1.tampered");
    const request = new Request("http://localhost/auth/me", {
      headers: { Cookie: tampered }
    });

    await expect(getSessionUser(request, localEnv)).resolves.toBeNull();
  });

  it("deletes KV session entries on logout", async () => {
    const localEnv = testEnv();
    const cookie = await createSession(localEnv, user);
    const request = new Request("http://localhost/auth/logout", {
      headers: { Cookie: cookie }
    });

    await destroySession(request, localEnv);

    await expect(getSessionUser(request, localEnv)).resolves.toBeNull();
  });

  it("does not delete sessions when logout receives a tampered cookie", async () => {
    const localEnv = testEnv();
    const cookie = await createSession(localEnv, user);
    const tampered = cookie.replace("v1.", "v1.tampered");
    const request = new Request("http://localhost/auth/logout", {
      headers: { Cookie: tampered }
    });

    await destroySession(request, localEnv);

    await expect(
      getSessionUser(
        new Request("http://localhost/auth/me", {
          headers: { Cookie: cookie }
        }),
        localEnv
      )
    ).resolves.toEqual(user);
  });

  it("rejects weak session secrets", async () => {
    await expect(createSession(testEnv({ SESSION_SECRET: "weak" }), user)).rejects.toThrow(/SESSION_SECRET/);
  });
});
