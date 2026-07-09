import type { AuthUser, Env } from "../env";
import { constantTimeEqual, hmacSha256Base64Url, sha256Base64Url } from "../lib/crypto";
import { randomBase64Url } from "../lib/encoding";

export const SESSION_COOKIE_NAME = "__Host-publicar_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

type StoredSession = {
  user: AuthUser;
  createdAt: number;
  expiresAt: number;
};

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function sessionTtl(env: Env): number {
  return parsePositiveInteger(env.SESSION_TTL_SECONDS, SESSION_TTL_SECONDS);
}

export function validateSessionSecret(env: Env): void {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters");
  }
}

function cookieHeaderValue(env: Env, name: string, value: string, maxAge: number): string {
  void env;
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function expiredCookieHeaderValue(env: Env, name: string): string {
  void env;
  return `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function parseCookie(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const [rawName, ...rawValueParts] = part.trim().split("=");
    if (!rawName) {
      continue;
    }
    cookies.set(rawName, rawValueParts.join("="));
  }
  return cookies;
}

async function sessionKey(sessionId: string): Promise<string> {
  return `session:${await sha256Base64Url(sessionId)}`;
}

export async function createSession(env: Env, user: AuthUser): Promise<string> {
  validateSessionSecret(env);
  const sessionId = randomBase64Url(32);
  const signature = await hmacSha256Base64Url(sessionId, env.SESSION_SECRET);
  const ttl = sessionTtl(env);
  const now = Date.now();
  const stored: StoredSession = {
    user,
    createdAt: now,
    expiresAt: now + ttl * 1000
  };
  await env.SESSIONS.put(await sessionKey(sessionId), JSON.stringify(stored), { expirationTtl: ttl });
  return cookieHeaderValue(env, SESSION_COOKIE_NAME, `v1.${sessionId}.${signature}`, ttl);
}

export function clearSessionCookie(env: Env): string {
  return expiredCookieHeaderValue(env, SESSION_COOKIE_NAME);
}

export async function getSessionUser(request: Request, env: Env): Promise<AuthUser | null> {
  const value = parseCookie(request.headers.get("Cookie")).get(SESSION_COOKIE_NAME);
  if (!value) {
    return null;
  }
  const sessionId = await verifiedSessionId(value, env);
  if (!sessionId) {
    return null;
  }

  const key = await sessionKey(sessionId);
  const storedValue = await env.SESSIONS.get(key);
  if (!storedValue) {
    return null;
  }
  const stored = JSON.parse(storedValue) as StoredSession;
  if (stored.expiresAt <= Date.now()) {
    await env.SESSIONS.delete(key);
    return null;
  }
  return stored.user;
}

async function verifiedSessionId(cookieValue: string, env: Env): Promise<string | null> {
  validateSessionSecret(env);
  const [version, sessionId, signature] = cookieValue.split(".");
  if (version !== "v1" || !sessionId || !signature) {
    return null;
  }
  const expectedSignature = await hmacSha256Base64Url(sessionId, env.SESSION_SECRET);
  return constantTimeEqual(signature, expectedSignature) ? sessionId : null;
}

export async function destroySession(request: Request, env: Env): Promise<void> {
  const value = parseCookie(request.headers.get("Cookie")).get(SESSION_COOKIE_NAME);
  if (!value) {
    return;
  }
  const sessionId = await verifiedSessionId(value, env);
  if (sessionId) {
    await env.SESSIONS.delete(await sessionKey(sessionId));
  }
}
