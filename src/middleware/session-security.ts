import type { MiddlewareHandler } from "hono";
import { getStoredSession } from "../auth/session";
import type { AppBindings } from "../env";

export const requireRecentSession: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (c.get("authMethod") !== "session") return c.json({ error: "session_required" }, 403);
  const session = await getStoredSession(c.req.raw, c.env);
  if (!session || Date.now() - session.createdAt > 15 * 60000) {
    return c.json({ error: "reauthentication_required", login_url: "/auth/login" }, 403);
  }
  return next();
};

// 投稿HTMLを含む別originから、Cookieを使った管理操作を開始させない。
export const rejectCrossOriginMutation: MiddlewareHandler<AppBindings> = async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return next();
  if (!pathname.startsWith("/api/") && !pathname.startsWith("/auth/")) return next();
  const origin = c.req.header("Origin");
  const site = c.req.header("Sec-Fetch-Site");
  if ((origin && origin !== new URL(c.req.url).origin) || site === "cross-site" || site === "same-site") {
    return c.json({ error: "cross_origin_request_denied" }, 403);
  }
  return next();
};
