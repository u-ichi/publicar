import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import migrationSql from "../migrations/0001_init.sql?raw";
import { SESSION_COOKIE_NAME } from "../src/auth/session";
import type { Env } from "../src/env";
import { bytesToBase64Url, jsonToBase64Url, utf8ToBytes } from "../src/lib/encoding";
import app from "../src/index";

const tableNames = [
  "oauth_states",
  "invites",
  "api_keys",
  "project_access",
  "project_files",
  "project_members",
  "projects",
  "users"
];

type SignedToken = {
  jwt: string;
  jwk: JsonWebKey & { kid: string; alg: string; use: string };
};

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
    ALLOWED_SIGNUP_DOMAINS: "example.com",
    GOOGLE_TOKEN_URL: "https://mock.local/token",
    GOOGLE_JWKS_URL: "https://mock.local/jwks",
    GOOGLE_USERINFO_URL: "https://mock.local/userinfo",
    SESSION_TTL_SECONDS: "604800",
    OAUTH_STATE_TTL_SECONDS: "600",
    ...overrides
  };
}

function db(): D1Database {
  return (env as unknown as Env).DB;
}

async function resetDb(): Promise<void> {
  await db().exec(`PRAGMA foreign_keys = OFF; ${tableNames.map((table) => `DROP TABLE IF EXISTS ${table};`).join(" ")}`);
  await db().exec(migrationSql.replace(/\s+/g, " "));
}

async function createSignedIdToken(claimOverrides: Record<string, unknown>): Promise<SignedToken> {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey & {
    kid: string;
    alg: string;
    use: string;
  };
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const header = jsonToBase64Url({ alg: "RS256", kid: "test-key", typ: "JWT" });
  const payload = jsonToBase64Url({
    iss: "https://accounts.google.com",
    aud: "test-client-id",
    exp: Math.floor(Date.now() / 1000) + 600,
    iat: Math.floor(Date.now() / 1000),
    sub: "google_123",
    email: "user@example.com",
    email_verified: true,
    hd: "example.com",
    name: "Example User",
    picture: "https://example.com/avatar.png",
    ...claimOverrides
  });
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, utf8ToBytes(input));
  return { jwt: `${input}.${bytesToBase64Url(new Uint8Array(signature))}`, jwk };
}

async function oauthState(localEnv: Env): Promise<{ state: string; nonce: string }> {
  const response = await app.fetch(new Request("http://localhost/auth/login?redirectTo=/dashboard"), localEnv);
  const location = response.headers.get("Location");
  expect(location).toBeTruthy();
  const url = new URL(location ?? "");
  const state = url.searchParams.get("state") ?? "";
  const nonce = url.searchParams.get("nonce") ?? "";
  expect(state.length).toBeGreaterThan(30);
  expect(nonce.length).toBeGreaterThan(30);
  const row = await localEnv.DB.prepare("SELECT nonce FROM oauth_states WHERE state = ?")
    .bind(state)
    .first<{ nonce: string }>();
  expect(row?.nonce).toBe(nonce);
  return { state, nonce };
}

function mockGoogleFetch(token: SignedToken, options: { tokenFailure?: boolean } = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === "https://mock.local/token") {
        if (options.tokenFailure) {
          return new Response("bad token", { status: 500 });
        }
        return Response.json({
          access_token: "plain-access-token",
          refresh_token: "plain-refresh-token",
          expires_in: 3600,
          id_token: token.jwt,
          token_type: "Bearer"
        });
      }
      if (url === "https://mock.local/jwks") {
        return Response.json({ keys: [token.jwk] });
      }
      if (url === "https://mock.local/userinfo") {
        return Response.json({
          sub: "google_123",
          email: "user@example.com",
          email_verified: true,
          name: "Example User",
          picture: "https://example.com/avatar.png"
        });
      }
      return new Response("not found", { status: 404 });
    })
  );
}

describe("Google OAuth routes", () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    await resetDb();
  });

  it("creates a Google login redirect with state, nonce, Drive scope, and account selection", async () => {
    const response = await app.fetch(new Request("http://localhost/auth/login?redirectTo=/dashboard"), testEnv());

    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    const url = new URL(location);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("nonce")).toBeTruthy();
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost/auth/callback");
  });

  it("exchanges a valid callback for an encrypted-token user row and session cookie", async () => {
    const localEnv = testEnv();
    const { state, nonce } = await oauthState(localEnv);
    mockGoogleFetch(await createSignedIdToken({ nonce }));

    const response = await app.fetch(new Request(`http://localhost/auth/callback?code=ok&state=${state}`), localEnv);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/dashboard");
    expect(response.headers.get("Set-Cookie")).toContain(`${SESSION_COOKIE_NAME}=v1.`);
    await expect(
      localEnv.DB.prepare("SELECT state FROM oauth_states WHERE state = ?").bind(state).first()
    ).resolves.toBeNull();

    const row = await db()
      .prepare("SELECT google_id, email, avatar_url, encrypted_access_token, encrypted_refresh_token FROM users WHERE google_id = ?")
      .bind("google_123")
      .first<{
        google_id: string;
        email: string;
        avatar_url: string | null;
        encrypted_access_token: string;
        encrypted_refresh_token: string;
      }>();

    expect(row?.email).toBe("user@example.com");
    expect(row?.avatar_url).toBe("https://example.com/avatar.png");
    expect(row?.encrypted_access_token).not.toContain("plain-access-token");
    expect(row?.encrypted_refresh_token).not.toContain("plain-refresh-token");
  });

  it("rejects callbacks with missing or reused state", async () => {
    const localEnv = testEnv();
    const response = await app.fetch(new Request("http://localhost/auth/callback?code=ok&state=missing"), localEnv);

    expect(response.status).toBe(400);
  });

  it("atomically consumes state so callback replay is rejected", async () => {
    const localEnv = testEnv();
    const { state, nonce } = await oauthState(localEnv);
    mockGoogleFetch(await createSignedIdToken({ nonce }));

    const first = await app.fetch(new Request(`http://localhost/auth/callback?code=ok&state=${state}`), localEnv);
    const second = await app.fetch(new Request(`http://localhost/auth/callback?code=ok&state=${state}`), localEnv);

    expect(first.status).toBe(302);
    expect(second.status).toBe(400);
  });

  it("rejects token exchange failures", async () => {
    const localEnv = testEnv();
    const { state, nonce } = await oauthState(localEnv);
    mockGoogleFetch(await createSignedIdToken({ nonce }), { tokenFailure: true });

    const response = await app.fetch(new Request(`http://localhost/auth/callback?code=ok&state=${state}`), localEnv);

    expect(response.status).toBe(400);
  });

  it("rejects accounts outside allowed domains", async () => {
    const localEnv = testEnv();
    const { state, nonce } = await oauthState(localEnv);
    mockGoogleFetch(await createSignedIdToken({ nonce, email: "user@other.com", hd: "other.com" }));

    const response = await app.fetch(new Request(`http://localhost/auth/callback?code=ok&state=${state}`), localEnv);

    expect(response.status).toBe(403);
  });

  it("rejects weak session secrets before storing OAuth tokens", async () => {
    const localEnv = testEnv({ SESSION_SECRET: "weak" });
    const { state } = await oauthState(localEnv);

    const response = await app.fetch(new Request(`http://localhost/auth/callback?code=ok&state=${state}`), localEnv);

    expect(response.status).toBe(400);
    await expect(db().prepare("SELECT id FROM users").first()).resolves.toBeNull();
  });

  it("rejects invalid token encryption keys before storing OAuth tokens", async () => {
    const localEnv = testEnv({ TOKEN_ENCRYPTION_KEY: "not-a-valid-key" });
    const { state } = await oauthState(localEnv);

    const response = await app.fetch(new Request(`http://localhost/auth/callback?code=ok&state=${state}`), localEnv);

    expect(response.status).toBe(400);
    await expect(db().prepare("SELECT id FROM users").first()).resolves.toBeNull();
  });
});
