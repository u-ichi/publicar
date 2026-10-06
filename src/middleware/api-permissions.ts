// APIキーは発行した本人として扱い、ブラウザのログインと同じ操作を許可する。
// APIキーで拒否する操作の一覧。拒否そのものは各ルートの定義に付けた requireSession / requireRecentSession が行い、
// この一覧はOpenAPIの説明と、実際のルートの挙動がこの一覧と一致するかを確かめるtestに使う。
export const sessionOnlyOperations = [
  // キーから新しい認証情報を作らせない。漏れたキーは取り消せば使えなくなる
  { method: "POST", path: "/api/v1/api-keys" },
  { method: "POST", path: "/api/v1/projects/:id/upload-keys" },
  // 組織管理者の操作（利用者の無効化など）
  { method: "GET", path: "/api/v1/organization/security-events" },
  { method: "GET", path: "/api/v1/organization/users/:id/revocation-impact" },
  { method: "POST", path: "/api/v1/organization/users/:id/disable" }
] as const;

// ルートの定義パス（例: /api/v1/projects/:id/upload-keys）で照合する。リクエストのURLの照合には使わない
export function isSessionOnlyOperation(method: string, routePath: string): boolean {
  return sessionOnlyOperations.some((item) => item.method === method && item.path === routePath);
}
