import type { MiddlewareHandler } from "hono";
import { getStoredSession } from "../auth/session";
import type { AppBindings } from "../env";

// 制限は各ルートの定義に付ける。URL文字列の照合で判定すると、符号化したパスで迂回されるため。

// ブラウザのログインだけに許す操作（APIキーからの認証情報の発行など）
export const requireSession: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (c.get("authMethod") !== "session") return c.json({ error: "session_required" }, 403);
  return next();
};

// ブラウザのログインだけに許し、直近15分以内のログインを求める操作
export const requireRecentSession: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (c.get("authMethod") !== "session") return c.json({ error: "session_required" }, 403);
  return requireRecentLogin(c, next);
};

// 管理操作。ブラウザのセッションには直近15分以内のログインを求め、APIキーは本人としてそのまま通す
export const requireRecentSessionIfSession: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (c.get("authMethod") !== "session") return next();
  return requireRecentLogin(c, next);
};

const requireRecentLogin: MiddlewareHandler<AppBindings> = async (c, next) => {
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
