import type { Env } from "../env";
import { base64ToBytes, bytesToBase64Url, jsonToBase64Url, utf8ToBytes } from "../lib/encoding";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive";
const tokens = new WeakMap<Env, { token: string; expiresAt: number; email: string; privateKey: string }>();

export function serviceAccountConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY && env.TEAM_DRIVE_ID);
}

export async function serviceAccountToken(env: Env, refresh = false): Promise<string> {
  if (!serviceAccountConfigured(env)) throw new Error("service_account_not_configured");
  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL!;
  const privateKey = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY!.replaceAll("\\n", "\n");
  const cached = tokens.get(env);
  if (!refresh && cached && cached.email === email && cached.privateKey === privateKey && cached.expiresAt > Date.now() + 60000) return cached.token;
  const key = await crypto.subtle.importKey("pkcs8", base64ToBytes(privateKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "")),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${jsonToBase64Url({ alg: "RS256", typ: "JWT" })}.${jsonToBase64Url({ iss: email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8ToBytes(unsigned));
  const response = await fetch(TOKEN_URL, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(60000), headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}` })
  });
  if (!response.ok) throw new Error("service_account_token_failed");
  const result = await response.json<{ access_token?: string; expires_in?: number; token_type?: string }>();
  if (!result.access_token || result.token_type?.toLowerCase() !== "bearer" || !Number.isFinite(result.expires_in) || result.expires_in! <= 0) {
    throw new Error("service_account_token_invalid");
  }
  tokens.set(env, { token: result.access_token, expiresAt: Date.now() + result.expires_in! * 1000, email, privateKey });
  return result.access_token;
}

export async function withServiceAccount<T>(env: Env, fn: (token: string) => Promise<T>): Promise<T> {
  try {
    return await fn(await serviceAccountToken(env));
  } catch (error) {
    if (error instanceof Error && /\b401\b/.test(error.message)) return fn(await serviceAccountToken(env, true));
    throw error;
  }
}
