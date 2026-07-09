import type { Env } from "../env";
import { decryptToken, encryptToken } from "../lib/crypto";

const CLI_AUTH_TTL_SECONDS = 300;

export async function insertCliAuthState(env: Env, state: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("DELETE FROM cli_auth_states WHERE expires_at <= ?").bind(now).run();
  await env.DB.prepare(
    "INSERT INTO cli_auth_states (state, status, expires_at) VALUES (?, 'pending', ?)"
  )
    .bind(state, now + CLI_AUTH_TTL_SECONDS)
    .run();
}

export async function completeCliAuthState(env: Env, state: string, apiKeyRaw: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const encryptedApiKey = await encryptToken(apiKeyRaw, env.TOKEN_ENCRYPTION_KEY);
  const result = await env.DB.prepare(
    `UPDATE cli_auth_states
     SET status = 'completed', api_key_raw = ?
     WHERE state = ? AND status = 'pending' AND expires_at > ?`
  )
    .bind(encryptedApiKey, state, now)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function consumeCliAuthState(env: Env, state: string): Promise<{ apiKeyRaw: string } | null> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `DELETE FROM cli_auth_states
     WHERE state = ? AND status = 'completed' AND expires_at > ?
     RETURNING api_key_raw`
  )
    .bind(state, now)
    .first<{ api_key_raw: string }>();
  if (!row) {
    return null;
  }
  if (row.api_key_raw.startsWith("pub_")) {
    return { apiKeyRaw: row.api_key_raw };
  }
  return { apiKeyRaw: await decryptToken(row.api_key_raw, env.TOKEN_ENCRYPTION_KEY) };
}

export async function findCliAuthState(env: Env, state: string): Promise<"pending" | null> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    "SELECT 1 FROM cli_auth_states WHERE state = ? AND status = 'pending' AND expires_at > ?"
  )
    .bind(state, now)
    .first();
  return row ? "pending" : null;
}
