import type { Env } from "../env";
import { sha256Base64Url } from "../lib/crypto";
import { randomBase64Url } from "../lib/encoding";
import { randomId } from "../lib/id";

const VALID_SCOPES = ["read", "write", "deploy"] as const;
export type Scope = (typeof VALID_SCOPES)[number];

export type ApiKey = {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  scopes: Scope[];
  lastUsedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
};

type ApiKeyRow = {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  scopes: string;
  last_used_at: string | null;
  created_at: string;
  expires_at: string | null;
};

function rowToApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: JSON.parse(row.scopes) as Scope[],
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

export function validateScopes(input: unknown): Scope[] | null {
  if (!Array.isArray(input) || input.length === 0) {
    return null;
  }
  for (const value of input) {
    if (!VALID_SCOPES.includes(value as Scope)) {
      return null;
    }
  }
  return input as Scope[];
}

async function generateApiKey(): Promise<{ raw: string; prefix: string; hash: string }> {
  const raw = `pub_${randomBase64Url(32)}`;
  return {
    raw,
    prefix: raw.slice(0, 12),
    hash: await sha256Base64Url(raw)
  };
}

export async function createApiKey(
  env: Env,
  userId: string,
  opts: { name: string; scopes?: Scope[]; expiresAt?: string | null }
): Promise<{ apiKey: ApiKey; rawKey: string }> {
  const { raw, prefix, hash } = await generateApiKey();
  const row = await env.DB.prepare(
    `INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, scopes, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING id, user_id, name, key_prefix, scopes, last_used_at, created_at, expires_at`
  )
    .bind(randomId("ak"), userId, opts.name, hash, prefix, JSON.stringify(opts.scopes ?? [...VALID_SCOPES]), opts.expiresAt ?? null)
    .first<ApiKeyRow>();

  if (!row) {
    throw new Error("Failed to create API key");
  }
  return { apiKey: rowToApiKey(row), rawKey: raw };
}

export async function listApiKeys(env: Env, userId: string): Promise<ApiKey[]> {
  const result = await env.DB.prepare(
    `SELECT id, user_id, name, key_prefix, scopes, last_used_at, created_at, expires_at
     FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`
  )
    .bind(userId)
    .all<ApiKeyRow>();
  return result.results.map(rowToApiKey);
}

export async function deleteApiKey(env: Env, id: string, userId: string): Promise<boolean> {
  const result = await env.DB.prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return result.meta.changes > 0;
}

export type ApiKeyLookup = {
  id: string;
  userId: string;
  scopes: Scope[];
  expiresAt: string | null;
};

export async function findApiKeyByHash(env: Env, hash: string): Promise<ApiKeyLookup | null> {
  const row = await env.DB.prepare("SELECT id, user_id, scopes, expires_at FROM api_keys WHERE key_hash = ?")
    .bind(hash)
    .first<{ id: string; user_id: string; scopes: string; expires_at: string | null }>();
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    userId: row.user_id,
    scopes: JSON.parse(row.scopes) as Scope[],
    expiresAt: row.expires_at
  };
}

export async function updateApiKeyLastUsed(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").bind(id).run();
}
