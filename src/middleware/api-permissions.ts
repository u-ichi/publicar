import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { getStoredSession } from "../auth/session";
import type { AppBindings } from "../env";

// APIキーは発行した本人として扱い、ブラウザのログインと同じ操作を許可する。
// ログイン方法で扱いを変える操作は、この表だけに置く。
// - sessionOnly: ブラウザのログインだけに許す（APIキーでは拒否）
// - recentLogin: ブラウザのログインでは、直近15分以内のログインを求める
// 照合にはルーターが選んだルートの定義パスを使う。リクエストURLの文字列で照合すると、符号化したパスで迂回されるため。
export const loginMethodRules = [
  // キーから新しい認証情報を作らせない。漏れたキーは取り消せば使えなくなる
  { method: "POST", path: "/api/v1/api-keys", sessionOnly: true, recentLogin: true },
  { method: "POST", path: "/api/v1/projects/:id/upload-keys", sessionOnly: true, recentLogin: false },
  // 組織管理者の操作（利用者の無効化など）
  { method: "GET", path: "/api/v1/organization/security-events", sessionOnly: true, recentLogin: true },
  { method: "GET", path: "/api/v1/organization/users/:id/revocation-impact", sessionOnly: true, recentLogin: true },
  { method: "POST", path: "/api/v1/organization/users/:id/disable", sessionOnly: true, recentLogin: true },
  // キー・プロジェクト・メンバー・招待の管理
  { method: "GET", path: "/api/v1/api-keys", sessionOnly: false, recentLogin: true },
  { method: "DELETE", path: "/api/v1/api-keys/:id", sessionOnly: false, recentLogin: true },
  { method: "POST", path: "/api/v1/projects", sessionOnly: false, recentLogin: true },
  { method: "PATCH", path: "/api/v1/projects/:id", sessionOnly: false, recentLogin: true },
  { method: "DELETE", path: "/api/v1/projects/:id", sessionOnly: false, recentLogin: true },
  { method: "POST", path: "/api/v1/projects/:id/members", sessionOnly: false, recentLogin: true },
  { method: "PATCH", path: "/api/v1/projects/:id/members/:userId", sessionOnly: false, recentLogin: true },
  { method: "DELETE", path: "/api/v1/projects/:id/members/:userId", sessionOnly: false, recentLogin: true },
  { method: "POST", path: "/api/v1/projects/:id/access", sessionOnly: false, recentLogin: true },
  { method: "DELETE", path: "/api/v1/projects/:id/access/:accessId", sessionOnly: false, recentLogin: true }
] as const;

export function findLoginMethodRule(method: string, routePath: string) {
  return loginMethodRules.find((rule) => rule.method === method && rule.path === routePath);
}

// ルーターが選んだルートのうち、処理本体（use ではないもの）に当てはまる規則を返す
function matchedRules(c: Context<AppBindings>) {
  return matchedRoutes(c).filter((route) => route.method !== "ALL").map((route) => findLoginMethodRule(route.method, route.path)).filter((rule) => rule !== undefined);
}

export const enforceLoginMethodRules: MiddlewareHandler<AppBindings> = async (c, next) => {
  const rules = matchedRules(c);
  if (rules.length === 0) return next();
  const authMethod = c.get("authMethod");
  if (rules.some((rule) => rule.sessionOnly) && authMethod !== "session") return c.json({ error: "session_required" }, 403);
  if (authMethod === "session" && rules.some((rule) => rule.recentLogin)) {
    const session = await getStoredSession(c.req.raw, c.env);
    if (!session || Date.now() - session.createdAt > 15 * 60000) {
      return c.json({ error: "reauthentication_required", login_url: "/auth/login" }, 403);
    }
  }
  return next();
};
