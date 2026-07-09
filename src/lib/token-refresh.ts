import { getUserTokens, updateUserTokens } from "../db/users";
import type { Env } from "../env";
import { decryptToken, encryptToken, validateTokenEncryptionKey } from "./crypto";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const REFRESH_SKEW_SECONDS = 60;

type RefreshResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type: string;
};

function requireTokenEnv(env: Env): void {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth client credentials are required");
  }
  validateTokenEncryptionKey(env.TOKEN_ENCRYPTION_KEY);
}

async function refreshAccessToken(env: Env, encryptedRefreshToken: string): Promise<RefreshResponse> {
  const refreshToken = await decryptToken(encryptedRefreshToken, env.TOKEN_ENCRYPTION_KEY);
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });
  const response = await fetch(env.GOOGLE_TOKEN_URL ?? GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) {
    throw new Error("Google token refresh failed");
  }
  return response.json<RefreshResponse>();
}

export async function getValidAccessToken(env: Env, userId: string, forceRefresh = false): Promise<string> {
  requireTokenEnv(env);
  const tokens = await getUserTokens(env, userId);
  if (!tokens?.encryptedAccessToken) {
    throw new Error("Google account must be reauthorized");
  }

  const now = Math.floor(Date.now() / 1000);
  if (!forceRefresh && tokens.tokenExpiresAt && tokens.tokenExpiresAt > now + REFRESH_SKEW_SECONDS) {
    return decryptToken(tokens.encryptedAccessToken, env.TOKEN_ENCRYPTION_KEY);
  }
  if (!tokens.encryptedRefreshToken) {
    throw new Error("Google account must be reauthorized");
  }

  const refreshed = await refreshAccessToken(env, tokens.encryptedRefreshToken);
  const encryptedAccessToken = await encryptToken(refreshed.access_token, env.TOKEN_ENCRYPTION_KEY);
  const encryptedRefreshToken = refreshed.refresh_token
    ? await encryptToken(refreshed.refresh_token, env.TOKEN_ENCRYPTION_KEY)
    : null;
  const tokenExpiresAt = refreshed.expires_in ? now + refreshed.expires_in : null;
  await updateUserTokens(env, userId, {
    encryptedAccessToken,
    encryptedRefreshToken,
    tokenExpiresAt
  });
  return refreshed.access_token;
}
