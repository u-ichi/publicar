import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../env";

// APIキーに許可する操作を列挙する。管理操作と未分類の経路は許可しない。
export const apiKeyPermissions = [
  { method: "GET", path: /^\/api\/v1\/whoami$/, scope: "read" },
  { method: "GET", path: /^\/api\/v1\/projects$/, scope: "read" },
  { method: "GET", path: /^\/api\/v1\/projects\/[^/]+$/, scope: "read" },
  { method: "GET", path: /^\/api\/v1\/projects\/[^/]+\/(files|comments|comment-threads|review-content)$/, scope: "read" },
  { method: "POST", path: /^\/api\/v1\/projects\/[^/]+\/deploy$/, scope: "deploy" },
  { method: "POST", path: /^\/api\/v1\/projects\/[^/]+\/comments(?:\/[^/]+\/replies)?$/, scope: "write" },
  { method: "PATCH", path: /^\/api\/v1\/projects\/[^/]+\/comments\/[^/]+$/, scope: "write" },
  { method: "DELETE", path: /^\/api\/v1\/projects\/[^/]+\/comments\/[^/]+$/, scope: "write" },
  { method: "DELETE", path: /^\/api\/v1\/projects\/[^/]+\/files$/, scope: "write" }
] as const;

export const enforceApiKeyPermissions: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (c.get("authMethod") !== "api-key") return next();
  const pathname = new URL(c.req.url).pathname.replace(/\/$/, "");
  const permission = apiKeyPermissions.find((item) => item.method === c.req.method && item.path.test(pathname));
  if (!permission) return c.json({ error: "session_required" }, 403);
  if (!(c.get("apiKeyScopes") ?? []).includes(permission.scope)) {
    return c.json({ error: "insufficient_scope", required: permission.scope }, 403);
  }
  const projectId = pathname.match(/^\/api\/v1\/projects\/([^/]+)/)?.[1];
  const allowedProjectId = c.get("apiKeyProjectId");
  if (projectId && allowedProjectId && decodeURIComponent(projectId) !== allowedProjectId) {
    return c.json({ error: "project_not_allowed" }, 403);
  }
  if (allowedProjectId && !projectId && pathname !== "/api/v1/whoami") {
    return c.json({ error: "project_not_allowed" }, 403);
  }
  return next();
};
