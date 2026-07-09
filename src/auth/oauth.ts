import { validateSessionSecret } from "./session";
import { createRemoteJWKSet, jwtVerify } from "./verify";
import { upsertOAuthUser } from "../db/users";
import type { AuthUser, Env } from "../env";
import { encryptToken, validateTokenEncryptionKey } from "../lib/crypto";
import { randomBase64Url } from "../lib/encoding";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const OAUTH_STATE_TTL_SECONDS = 60 * 10;
const OAUTH_SCOPES = ["openid", "email", "profile", "https://www.googleapis.com/auth/drive.file"];

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token: string;
  token_type: string;
};

type UserInfoResponse = {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};

export type IdTokenClaims = {
  iss: string;
  aud: string;
  exp: number;
  sub: string;
  email: string;
  email_verified: boolean;
  hd?: string;
  name?: string;
  picture?: string;
};

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function allowedDomains(env: Env): string[] {
  return (env.ALLOWED_SIGNUP_DOMAINS ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

function emailDomain(email: string): string | null {
  const [, domain] = email.toLowerCase().split("@");
  return domain || null;
}

export function callbackUrl(request: Request, env: Env): string {
  if (env.GOOGLE_REDIRECT_URI) {
    return env.GOOGLE_REDIRECT_URI;
  }
  return new URL("/auth/callback", request.url).toString();
}

function requireNonEmpty(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function validateLoginEnv(env: Env): void {
  requireNonEmpty(env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID");
}

function validateCallbackEnv(env: Env): void {
  validateLoginEnv(env);
  requireNonEmpty(env.GOOGLE_CLIENT_SECRET, "GOOGLE_CLIENT_SECRET");
  validateTokenEncryptionKey(env.TOKEN_ENCRYPTION_KEY);
  validateSessionSecret(env);
}

export async function createLoginUrl(request: Request, env: Env): Promise<string> {
  validateLoginEnv(env);
  const state = randomBase64Url(32);
  const nonce = randomBase64Url(32);
  const redirectTo = new URL(request.url).searchParams.get("redirectTo") ?? "/";
  const safeRedirectTo = redirectTo.startsWith("/") && !redirectTo.startsWith("//") ? redirectTo : "/";
  const ttl = parsePositiveInteger(env.OAUTH_STATE_TTL_SECONDS, OAUTH_STATE_TTL_SECONDS);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").bind(now).run();
  await env.DB.prepare("INSERT INTO oauth_states (state, nonce, redirect_to, expires_at) VALUES (?, ?, ?, ?)")
    .bind(state, nonce, safeRedirectTo, now + ttl)
    .run();

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", callbackUrl(request, env));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

async function consumeOAuthState(env: Env, state: string): Promise<{ nonce: string; redirectTo: string } | null> {
  const row = await env.DB.prepare(
    "DELETE FROM oauth_states WHERE state = ? AND expires_at > ? RETURNING nonce, redirect_to"
  )
    .bind(state, Math.floor(Date.now() / 1000))
    .first<{ nonce: string; redirect_to: string }>();
  if (!row) {
    return null;
  }
  return { nonce: row.nonce, redirectTo: row.redirect_to };
}

async function exchangeCode(request: Request, env: Env, code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: callbackUrl(request, env),
    grant_type: "authorization_code"
  });
  const response = await fetch(env.GOOGLE_TOKEN_URL ?? GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) {
    throw new Error("OAuth token exchange failed");
  }
  return response.json<TokenResponse>();
}

async function fetchUserInfo(env: Env, accessToken: string): Promise<UserInfoResponse> {
  const response = await fetch(env.GOOGLE_USERINFO_URL ?? GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    throw new Error("OAuth userinfo failed");
  }
  return response.json<UserInfoResponse>();
}

export async function verifyGoogleIdToken(env: Env, idToken: string, nonce: string): Promise<IdTokenClaims> {
  const jwks = createRemoteJWKSet(env.GOOGLE_JWKS_URL ?? GOOGLE_JWKS_URL);
  const claims = await jwtVerify<IdTokenClaims>(idToken, jwks, {
    audience: env.GOOGLE_CLIENT_ID,
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    nonce
  });
  if (!claims.email_verified) {
    throw new Error("Google email is not verified");
  }
  return claims;
}

function assertAllowedDomain(env: Env, claims: IdTokenClaims): void {
  const domains = allowedDomains(env);
  if (domains.length === 0) {
    return;
  }
  const domain = emailDomain(claims.email);
  if (!domain || !domains.includes(domain) || claims.hd?.toLowerCase() !== domain) {
    throw new Error("Google account domain is not allowed");
  }
}

export async function handleOAuthCallback(request: Request, env: Env): Promise<{
  user: AuthUser;
  redirectTo: string;
}> {
  validateCallbackEnv(env);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    throw new Error("OAuth callback is missing code or state");
  }
  const storedState = await consumeOAuthState(env, state);
  if (!storedState) {
    throw new Error("OAuth state is invalid");
  }
  const token = await exchangeCode(request, env, code);
  const claims = await verifyGoogleIdToken(env, token.id_token, storedState.nonce);
  assertAllowedDomain(env, claims);
  const userInfo = await fetchUserInfo(env, token.access_token);
  if (userInfo.sub !== claims.sub || userInfo.email !== claims.email || userInfo.email_verified === false) {
    throw new Error("OAuth userinfo does not match ID token");
  }
  const expiresAt = token.expires_in ? Math.floor(Date.now() / 1000) + token.expires_in : null;
  const user = await upsertOAuthUser(env, {
    googleId: claims.sub,
    email: claims.email,
    name: userInfo.name ?? claims.name ?? null,
    avatarUrl: userInfo.picture ?? claims.picture ?? null,
    encryptedAccessToken: await encryptToken(token.access_token, env.TOKEN_ENCRYPTION_KEY),
    encryptedRefreshToken: token.refresh_token
      ? await encryptToken(token.refresh_token, env.TOKEN_ENCRYPTION_KEY)
      : null,
    tokenExpiresAt: expiresAt
  });
  return { user, redirectTo: storedState.redirectTo };
}
