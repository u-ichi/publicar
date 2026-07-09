import type { MiddlewareHandler } from "hono";
import { getSessionUser } from "../auth/session";
import { findApiKeyByHash, updateApiKeyLastUsed } from "../db/api-keys";
import { getUserById } from "../db/users";
import type { AppBindings } from "../env";
import { sha256Base64Url } from "../lib/crypto";

function acceptsHtml(request: Request): boolean {
  return request.headers.get("Accept")?.includes("text/html") ?? false;
}

export const resolveAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (authHeader?.startsWith("Bearer pub_")) {
    const token = authHeader.slice(7);
    const keyInfo = await findApiKeyByHash(c.env, await sha256Base64Url(token));
    if (!keyInfo) {
      return c.json({ error: "invalid_api_key" }, 401);
    }
    if (keyInfo.expiresAt && new Date(keyInfo.expiresAt) < new Date()) {
      return c.json({ error: "api_key_expired" }, 401);
    }
    const user = await getUserById(c.env, keyInfo.userId);
    if (!user) {
      return c.json({ error: "invalid_api_key" }, 401);
    }

    c.set("user", user);
    c.set("authMethod", "api-key");
    c.set("apiKeyScopes", keyInfo.scopes);
    c.set("apiKeyId", keyInfo.id);
    await updateApiKeyLastUsed(c.env, keyInfo.id);
    return next();
  }

  if (authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "invalid_bearer_token" }, 401);
  }

  const user = await getSessionUser(c.req.raw, c.env);
  if (user) {
    c.set("user", user);
    c.set("authMethod", "session");
  }
  return next();
};

export const requireAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (!c.get("user")) {
    if (acceptsHtml(c.req.raw)) {
      return c.redirect("/auth/login", 302);
    }
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
};

export function requireScope(scope: string): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    if (c.get("authMethod") === "api-key") {
      const scopes = c.get("apiKeyScopes") ?? [];
      if (!scopes.includes(scope)) {
        return c.json({ error: "insufficient_scope", required: scope }, 403);
      }
    }
    return next();
  };
}
