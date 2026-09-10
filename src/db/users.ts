import type { AuthUser, Env, UserKind } from "../env";

export type OAuthUserInput = {
  googleId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  kind: UserKind;
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
  kind: UserKind | null;
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
    avatarUrl: row.avatar_url,
    kind: row.kind === "guest" ? "guest" : "member"
  };
}

const USER_SELECT = "id, google_id, email, name, avatar_url, kind";

export async function upsertOAuthUser(env: Env, user: OAuthUserInput): Promise<AuthUser> {
  const result = await env.DB.prepare(
    `INSERT INTO users (
      id, google_id, email, name, avatar_url, kind, encrypted_access_token,
      encrypted_refresh_token, token_expires_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(google_id) DO UPDATE SET
      email = excluded.email,
      name = excluded.name,
      avatar_url = excluded.avatar_url,
      kind = excluded.kind,
      encrypted_access_token = excluded.encrypted_access_token,
      encrypted_refresh_token = COALESCE(excluded.encrypted_refresh_token, users.encrypted_refresh_token),
      token_expires_at = excluded.token_expires_at,
      updated_at = datetime('now')
    WHERE users.disabled_at IS NULL
    RETURNING ${USER_SELECT}`
  )
    .bind(
      crypto.randomUUID(),
      user.googleId,
      user.email,
      user.name,
      user.avatarUrl,
      user.kind,
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
  const row = await env.DB.prepare(`SELECT ${USER_SELECT} FROM users WHERE id = ? AND disabled_at IS NULL`)
    .bind(id)
    .first<UserRow>();
  return row ? rowToUser(row) : null;
}

export async function getUserByEmail(env: Env, email: string): Promise<AuthUser | null> {
  const row = await env.DB.prepare(`SELECT ${USER_SELECT} FROM users WHERE lower(email) = lower(?)`)
    .bind(email)
    .first<UserRow>();
  return row ? rowToUser(row) : null;
}

export async function getUserTokens(env: Env, id: string): Promise<UserTokens | null> {
  const row = await env.DB.prepare(
    `SELECT encrypted_access_token, encrypted_refresh_token, token_expires_at
     FROM users WHERE id = ? AND disabled_at IS NULL`
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
  const result = await env.DB.prepare(
    `UPDATE users SET
      encrypted_access_token = ?,
      encrypted_refresh_token = COALESCE(?, encrypted_refresh_token),
      token_expires_at = ?,
      updated_at = datetime('now')
     WHERE id = ? AND disabled_at IS NULL`
  )
    .bind(tokens.encryptedAccessToken, tokens.encryptedRefreshToken, tokens.tokenExpiresAt, id)
    .run();
  if (!result.meta.changes) throw new Error("Google account must be reauthorized");
}
