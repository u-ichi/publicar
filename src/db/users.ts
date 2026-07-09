import type { AuthUser, Env } from "../env";

export type OAuthUserInput = {
  googleId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  tokenExpiresAt: number | null;
};

export type UserSummary = {
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
};

type UserRow = {
  id: string;
  google_id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
};

export type UserTokens = {
  encryptedAccessToken: string | null;
  encryptedRefreshToken: string | null;
  tokenExpiresAt: number | null;
};

function rowToUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    googleId: row.google_id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url
  };
}

export async function upsertOAuthUser(env: Env, user: OAuthUserInput): Promise<AuthUser> {
  const result = await env.DB.prepare(
    `INSERT INTO users (
      id, google_id, email, name, avatar_url, encrypted_access_token,
      encrypted_refresh_token, token_expires_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(google_id) DO UPDATE SET
      email = excluded.email,
      name = excluded.name,
      avatar_url = excluded.avatar_url,
      encrypted_access_token = excluded.encrypted_access_token,
      encrypted_refresh_token = COALESCE(excluded.encrypted_refresh_token, users.encrypted_refresh_token),
      token_expires_at = excluded.token_expires_at,
      updated_at = datetime('now')
    RETURNING id, google_id, email, name, avatar_url`
  )
    .bind(
      crypto.randomUUID(),
      user.googleId,
      user.email,
      user.name,
      user.avatarUrl,
      user.encryptedAccessToken,
      user.encryptedRefreshToken,
      user.tokenExpiresAt
    )
    .first<UserRow>();

  if (!result) {
    throw new Error("Failed to upsert OAuth user");
  }
  return rowToUser(result);
}

export async function getUserById(env: Env, id: string): Promise<AuthUser | null> {
  const row = await env.DB.prepare("SELECT id, google_id, email, name, avatar_url FROM users WHERE id = ?")
    .bind(id)
    .first<UserRow>();
  return row ? rowToUser(row) : null;
}

export async function getUserByEmail(env: Env, email: string): Promise<AuthUser | null> {
  const row = await env.DB.prepare("SELECT id, google_id, email, name, avatar_url FROM users WHERE lower(email) = lower(?)")
    .bind(email)
    .first<UserRow>();
  return row ? rowToUser(row) : null;
}

export async function getUserTokens(env: Env, id: string): Promise<UserTokens | null> {
  const row = await env.DB.prepare(
    `SELECT encrypted_access_token, encrypted_refresh_token, token_expires_at
     FROM users WHERE id = ?`
  )
    .bind(id)
    .first<{
      encrypted_access_token: string | null;
      encrypted_refresh_token: string | null;
      token_expires_at: number | null;
    }>();
  if (!row) {
    return null;
  }
  return {
    encryptedAccessToken: row.encrypted_access_token,
    encryptedRefreshToken: row.encrypted_refresh_token,
    tokenExpiresAt: row.token_expires_at
  };
}

export async function updateUserTokens(
  env: Env,
  id: string,
  tokens: {
    encryptedAccessToken: string;
    encryptedRefreshToken: string | null;
    tokenExpiresAt: number | null;
  }
): Promise<void> {
  await env.DB.prepare(
    `UPDATE users SET
      encrypted_access_token = ?,
      encrypted_refresh_token = COALESCE(?, encrypted_refresh_token),
      token_expires_at = ?,
      updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(tokens.encryptedAccessToken, tokens.encryptedRefreshToken, tokens.tokenExpiresAt, id)
    .run();
}
