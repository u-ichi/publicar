import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../auth/session";
import { createApiKey } from "../db/api-keys";
import { createProject } from "../db/projects";
import { app } from "../index";
import { isSessionOnlyOperation, sessionOnlyOperations } from "../middleware/api-permissions";
import { authCookie, mockDriveUploads, resetDatabase, seedUser, testEnv, user } from "./helpers";

type Auth = "session" | "api-key";

// 毎回同じ初期状態（本人が所有するプロジェクト1件）を作り、1つのルートを1つの認証方法で呼ぶ
async function callRoute(method: string, routePath: string, auth: Auth): Promise<{ status: number; error?: string }> {
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
  const response = await app.fetch(new Request(`http://localhost${path}`, { method, headers, ...(method === "GET" ? {} : { body: "{}" }) }), env);
  const body = await response.clone().json().catch(() => null) as { error?: string } | null;
  vi.unstubAllGlobals();
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
      if (isSessionOnlyOperation(route.method, route.path)) {
        expect(apiKey, label).toEqual({ status: 403, error: "session_required" });
      } else {
        expect(apiKey, label).toEqual(session);
      }
    }
  });

  it("lists only routes that exist as session-only operations", () => {
    for (const item of sessionOnlyOperations) {
      expect(app.routes.some((route) => route.method === item.method && route.path === item.path), `${item.method} ${item.path}`).toBe(true);
    }
  });

  // ルーターは復号したパスで処理先を決めるため、符号化したパスでも同じ制限がかかることを確かめる
  it("keeps session-only and recent-login restrictions on percent-encoded paths", async () => {
    const env = testEnv();
    const cookie = await createSession(env, user);
    const { rawKey } = await createApiKey(env, user.id, { name: "CLI" });
    const withKey = { Authorization: `Bearer ${rawKey}`, "Content-Type": "application/json" };
    const created = await app.fetch(new Request("http://localhost/api/v1/%61pi-keys", { method: "POST", headers: withKey, body: JSON.stringify({ name: "escaped" }) }), env);
    expect(created.status).toBe(403);
    const organization = await app.fetch(new Request("http://localhost/api/v1/%6frganization/security-events", { headers: withKey }), env);
    expect(organization.status).toBe(403);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60000);
    const stale = await app.fetch(new Request("http://localhost/api/v1/%6frganization/security-events", { headers: { Cookie: cookie } }), env);
    expect(stale.status).toBe(403);
    await expect(stale.json()).resolves.toMatchObject({ error: "reauthentication_required" });
  });
});
