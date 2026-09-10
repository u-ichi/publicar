import type { MiddlewareHandler } from "hono";
import { getActiveSessionUser } from "../auth/session";
import { expirationTime, findApiKeyByHash, updateApiKeyLastUsed } from "../db/api-keys";
import { getUserById } from "../db/users";
import type { AppBindings } from "../env";
import { sha256Base64Url } from "../lib/crypto";
import { findUploadKey, UPLOAD_KEY_PREFIX } from "../db/upload-keys";

function acceptsHtml(request: Request): boolean {
  return request.headers.get("Accept")?.includes("text/html") ?? false;
}

/** guest が使える /api パス (deny-by-default) */
export function isGuestAllowedApiPath(pathname: string): boolean {
  if (pathname === "/api/v1/whoami") {
    return true;
  }
  if (pathname === "/api/v1/notifications" || pathname.startsWith("/api/v1/notifications/")) {
    return true;
  }
  // 閲覧権限は各経路でprojectごとに確認する。
  return /^\/api\/v1\/projects\/[^/]+\/(comments|comment-threads|review-content|content-url)(\/|$)/.test(pathname);
}

export const resolveAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (authHeader?.startsWith(`Bearer ${UPLOAD_KEY_PREFIX}`)) {
    c.set("authMethod", "upload-key");
    const key = await findUploadKey(c.env, authHeader.slice(7));
    if (key) c.set("auditedUploadKeyId", key.id);
    if (!key || key.revoked_at || !(Date.parse(key.expires_at) > Date.now())) {
      c.set("rejectionReason", "invalid_upload_key");
      return c.json({ error: "invalid_upload_key" }, 401);
    }
    c.set("uploadKey", { id: key.id, projectId: key.project_id });
    c.set("principal", { kind: "upload-key", keyId: key.id, projectId: key.project_id });
    const allowedPath = `/api/v1/projects/${encodeURIComponent(key.project_id)}/deploy`;
    if (c.req.method !== "POST" || new URL(c.req.url).pathname !== allowedPath) {
      c.set("rejectionReason", "upload_operation_not_allowed");
      return c.json({ error: "upload_operation_not_allowed" }, 403);
    }
    return next();
  }

  if (authHeader?.startsWith("Bearer pub_")) {
    const token = authHeader.slice(7);
    const keyInfo = await findApiKeyByHash(c.env, await sha256Base64Url(token));
    if (!keyInfo) {
      return c.json({ error: "invalid_api_key" }, 401);
    }
    c.set("authMethod", "api-key");
    c.set("apiKeyId", keyInfo.id);
    c.set("apiKeyProjectId", keyInfo.projectId);
    if (keyInfo.revokedAt) return c.json({ error: "api_key_revoked" }, 401);
    if (keyInfo.expiresAt !== null && !(expirationTime(keyInfo.expiresAt) > Date.now())) {
      return c.json({ error: "api_key_expired" }, 401);
    }
    const user = await getUserById(c.env, keyInfo.userId);
    if (!user) {
      return c.json({ error: "invalid_api_key" }, 401);
    }
    // guest の残存 API key は拒否 (防御の重ね掛け)
    if (user.kind === "guest") {
      return c.json({ error: "forbidden" }, 403);
    }

    if (keyInfo.automationGrantId) return c.json({ error: "automation_key_retired" }, 403);

    c.set("user", user);
    c.set("principal", { kind: "user", user });
    c.set("authMethod", "api-key");
    c.set("apiKeyScopes", keyInfo.scopes);
    c.set("apiKeyId", keyInfo.id);
    await updateApiKeyLastUsed(c.env, keyInfo.id);
    return next();
  }

  if (authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "invalid_bearer_token" }, 401);
  }

  const sessionUser = await getActiveSessionUser(c.req.raw, c.env);
  if (sessionUser) {
    // kind 等は users 行から解決 (session 内の stale 値を使わない)
    const user = await getUserById(c.env, sessionUser.id);
    if (user) {
      c.set("user", user);
      c.set("principal", { kind: "user", user });
      c.set("authMethod", "session");
    }
  }
  return next();
};

export const requireAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (!c.get("user") && c.get("principal")?.kind !== "upload-key") {
    if (acceptsHtml(c.req.raw)) {
      return c.redirect("/auth/login", 302);
    }
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
};

/** guest を allowlist 外の /api/* から遮断する */
export const requireGuestAllowlist: MiddlewareHandler<AppBindings> = async (c, next) => {
  const user = c.get("user");
  if (!user || user.kind !== "guest") {
    return next();
  }
  const pathname = new URL(c.req.url).pathname;
  if (!isGuestAllowedApiPath(pathname)) {
    return c.json({ error: "forbidden" }, 403);
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
