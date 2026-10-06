import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKey } from "../db/api-keys";
import { app } from "../index";
import { isSessionOnlyOperation } from "../middleware/api-permissions";
import { resetDatabase, seedUser, testEnv, user } from "./helpers";

// 登録されたすべての /api/v1 経路で、APIキーがログイン方法を理由に拒否されないことを確かめる。
// 新しい経路を足した時に、sessionOnlyOperations へ載せない限りAPIキーでも呼べる状態を保つ。
describe("API key route coverage", () => {
  beforeEach(async () => { vi.unstubAllGlobals(); await resetDatabase(testEnv()); await seedUser(testEnv()); });

  it("treats an API key as the user on every API route except session-only operations", async () => {
    const env = testEnv();
    const { rawKey } = await createApiKey(env, user.id, { name: "CLI" });
    const routes = app.routes.filter((route) => route.method !== "ALL" && route.path.startsWith("/api/v1/"));
    expect(routes.length).toBeGreaterThan(20);
    for (const route of routes) {
      const path = route.path.replace(/:[A-Za-z]+(\{[^}]*\})?/g, "missing");
      const response = await app.fetch(new Request(`http://localhost${path}`, {
        method: route.method,
        headers: { Authorization: `Bearer ${rawKey}`, "Content-Type": "application/json" },
        ...(route.method === "GET" ? {} : { body: "{}" })
      }), env);
      const body = await response.clone().json().catch(() => null) as { error?: string } | null;
      const label = `${route.method} ${route.path}`;
      if (isSessionOnlyOperation(route.method, path)) {
        expect(body?.error, label).toBe("session_required");
      } else {
        expect(response.status, label).not.toBe(401);
        expect(body?.error, label).not.toBe("session_required");
      }
    }
  });
});
