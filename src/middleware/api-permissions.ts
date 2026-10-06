import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../env";

// APIキーは発行した本人として扱い、ブラウザのログインと同じ操作を許可する。
// 何ができるかは各経路の権限確認だけで決め、APIキーで拒否する操作はこの表だけに置く。
export const sessionOnlyOperations = [
  // キーから新しい認証情報を作らせない。漏れたキーは取り消せば使えなくなる
  { method: "POST", path: /^\/api\/v1\/api-keys$/ },
  { method: "POST", path: /^\/api\/v1\/projects\/[^/]+\/upload-keys$/ },
  // 組織管理者の操作（利用者の無効化など）
  { method: "*", path: /^\/api\/v1\/organization(?:\/|$)/ }
] as const;

export function isSessionOnlyOperation(method: string, pathname: string): boolean {
  return sessionOnlyOperations.some((item) => (item.method === "*" || item.method === method) && item.path.test(pathname));
}

export const enforceApiKeyPermissions: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (c.get("authMethod") !== "api-key") return next();
  const pathname = new URL(c.req.url).pathname.replace(/\/$/, "");
  if (isSessionOnlyOperation(c.req.method, pathname)) return c.json({ error: "session_required" }, 403);
  return next();
};
