import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../auth/session";
import { createApiKey } from "../db/api-keys";
import { createProject } from "../db/projects";
import { app } from "../index";
import { findLoginMethodRule } from "../middleware/api-permissions";
import { authCookie, mockDriveUploads, resetDatabase, seedUser, testEnv, user } from "./helpers";

type Auth = "session" | "api-key";

// 毎回同じ初期状態（本人が所有するプロジェクト1件）を作り、1つのルートを1つの認証方法で呼ぶ
async function callRoute(method: string, routePath: string, auth: Auth, staleSession = false): Promise<{ status: number; error?: string }> {
  const env = testEnv();
  await resetDatabase(env);
  const cookie = await authCookie(env);
  const project = await createProject(env, user, { title: "Own", alias: "own-doc", visibility: "private" });
  const { rawKey } = await createApiKey(env, user.id, { name: "CLI" });
  mockDriveUploads();
  const path = routePath
    .replace(/^\/api\/v1\/projects\/:id/, `/api/v1/projects/${project.id}`)
    .replace(/:userId/g, user.id)
    .replace(/:[A-Za-z]+(\{[^}]*\})?/g, "missing");
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(auth === "session" ? { Cookie: cookie } : { Authorization: `Bearer ${rawKey}` }) };
  const now = Date.now();
  if (staleSession) vi.spyOn(Date, "now").mockReturnValue(now + 16 * 60000);
  const response = await app.fetch(new Request(`http://localhost${path}`, { method, headers, ...(method === "GET" ? {} : { body: "{}" }) }), env);
  const body = await response.clone().json().catch(() => null) as { error?: string } | null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  return { status: response.status, error: body?.error };
}

describe("API key route coverage", () => {
  beforeEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await resetDatabase(testEnv()); await seedUser(testEnv()); });

  // 登録されたすべての /api/v1 ルートで、本人のAPIキーがブラウザのログインと同じ結果になることを確かめる。
  // 新しいルートや、ルート内でログイン方法により分岐する処理を足すと、sessionOnlyOperations に載せない限りここで失敗する。
  it("gives an API key the same result as the user's browser session on every API route", async () => {
    const routes = app.routes.filter((route) => route.method !== "ALL" && route.path.startsWith("/api/v1/"));
    expect(routes.length).toBeGreaterThan(20);
    for (const route of routes) {
      const label = `${route.method} ${route.path}`;
      const session = await callRoute(route.method, route.path, "session");
      const apiKey = await callRoute(route.method, route.path, "api-key");
      if (findLoginMethodRule(route.method, route.path)?.sessionOnly) {
        expect(apiKey, label).toEqual({ status: 403, error: "session_required" });
      } else {
        expect(apiKey, label).toEqual(session);
      }
    }
  });

  // 表で recentLogin とした操作だけが、ログインから16分経ったブラウザで再ログインを求められることを確かめる
  it("asks for a recent browser login exactly on the routes marked recentLogin", async () => {
    const routes = app.routes.filter((route) => route.method !== "ALL" && route.path.startsWith("/api/v1/"));
    for (const route of routes) {
      const label = `${route.method} ${route.path}`;
      const stale = await callRoute(route.method, route.path, "session", true);
      if (findLoginMethodRule(route.method, route.path)?.recentLogin) {
        expect(stale, label).toEqual({ status: 403, error: "reauthentication_required" });
      } else {
        expect(stale.error, label).not.toBe("reauthentication_required");
      }
    }
  });

  // 符号化したURLでも、キーの発行・組織管理・別サイトからの変更操作が拒否されることを確かめる（実際に見つかった迂回）
  it("keeps restrictions on percent-encoded paths", async () => {
    const env = testEnv();
    const cookie = await createSession(env, user);
    const { rawKey } = await createApiKey(env, user.id, { name: "CLI" });
    const withKey = { Authorization: `Bearer ${rawKey}`, "Content-Type": "application/json" };
    expect((await app.fetch(new Request("http://localhost/api/v1/%61pi-keys", { method: "POST", headers: withKey, body: JSON.stringify({ name: "escaped" }) }), env)).status).toBe(403);
    expect((await app.fetch(new Request("http://localhost/api/v1/%6frganization/security-events", { headers: withKey }), env)).status).toBe(403);
    const crossOrigin = await app.fetch(new Request("http://localhost/%61pi/v1/api-keys", {
      method: "POST", headers: { Cookie: cookie, Origin: "https://content.example", "Sec-Fetch-Site": "same-site", "Content-Type": "text/plain" }, body: JSON.stringify({ name: "csrf" })
    }), env);
    await expect(crossOrigin.json()).resolves.toEqual({ error: "cross_origin_request_denied" });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM api_keys").first()).toEqual({ n: 1 });

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60000);
    const stale = await app.fetch(new Request("http://localhost/api/v1/%6frganization/security-events", { headers: { Cookie: cookie } }), env);
    await expect(stale.json()).resolves.toMatchObject({ error: "reauthentication_required" });
  });
});
