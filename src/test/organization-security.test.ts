import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../auth/session";
import { updateUserTokens } from "../db/users";
import { createApiKey } from "../db/api-keys";
import { createProject } from "../db/projects";
import app from "../index";
import { editorUser, mockDriveUploads, resetDatabase, seedUser, testEnv, user } from "./helpers";

describe("organization security", () => {
  beforeEach(async () => { vi.unstubAllGlobals(); await resetDatabase(testEnv()); await seedUser(testEnv()); });

  it("does not let an API key issue new credentials", async () => {
    const env = testEnv();
    const { rawKey } = await createApiKey(env, user.id, { name: "CLI" });
    const project = await createProject(env, user, { title: "Private", alias: "private-doc", visibility: "private" });
    // キーから新しい認証情報を作らせない（sessionOnlyOperations）
    for (const [path, body] of [
      ["/api/v1/api-keys", { name: "escaped" }],
      [`/api/v1/projects/${project.id}/upload-keys`, { name: "escaped", expires_at: new Date(Date.now() + 86400000).toISOString() }]
    ] as const) {
      const response = await app.fetch(new Request(`http://localhost${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${rawKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body)
      }), env);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "session_required" });
    }
  });

  it("lets an API key create and delete the user's own project", async () => {
    const env = testEnv();
    const { rawKey } = await createApiKey(env, user.id, { name: "CLI" });
    const headers = { Authorization: `Bearer ${rawKey}`, "Content-Type": "application/json" };
    const created = await app.fetch(new Request("http://localhost/api/v1/projects", {
      method: "POST", headers, body: JSON.stringify({ title: "created-by-cli", alias: "created-by-cli" })
    }), env);
    expect(created.status).toBe(201);
    const { project } = (await created.json()) as { project: { id: string } };
    const deleted = await app.fetch(new Request(`http://localhost/api/v1/projects/${project.id}`, { method: "DELETE", headers }), env);
    expect(deleted.status).toBe(200);
  });

  it("rejects malformed stored key expiry", async () => {
    const env = testEnv();
    const { rawKey } = await createApiKey(env, user.id, { name: "invalid-expiry", expiresAt: "invalid" });
    const response = await app.fetch(new Request("http://localhost/api/v1/whoami", { headers: { Authorization: `Bearer ${rawKey}` } }), env);
    expect(response.status).toBe(401);
  });

  it("rejects cross-origin session writes and audits denied operations", async () => {
    const env = testEnv();
    const cookie = await createSession(env, user);
    const response = await app.fetch(new Request("http://localhost/api/v1/api-keys", {
      method: "POST", headers: { Cookie: cookie, Origin: "https://content.example", "Content-Type": "application/json" }, body: JSON.stringify({ name: "bad" })
    }), env);
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const log = await env.DB.prepare("SELECT status FROM security_events WHERE route = '/api/v1/api-keys'").first<{ status: number }>();
    expect(log?.status).toBe(403);
  });

  it("revokes sessions, keys, and Google tokens when an administrator disables an account", async () => {
    const env = testEnv({ AUTOMATION_ORGANIZATION_ID: "org-test", ORGANIZATION_ADMIN_EMAILS: user.email });
    await seedUser(env, editorUser);
    const adminCookie = await createSession(env, user);
    const disabledCookie = await createSession(env, editorUser);
    const { rawKey } = await createApiKey(env, editorUser.id, { name: "retired" });
    const disabled = await app.fetch(new Request(`http://localhost/api/v1/organization/users/${editorUser.id}/disable`, { method: "POST", headers: { Cookie: adminCookie } }), env);
    expect(disabled.status).toBe(200);
    for (const path of ["/auth/me", "/api/v1/whoami"]) {
      expect((await app.fetch(new Request(`http://localhost${path}`, { headers: { Cookie: disabledCookie } }), env)).status).toBe(401);
    }
    expect((await app.fetch(new Request("http://localhost/api/v1/whoami", { headers: { Authorization: `Bearer ${rawKey}` } }), env)).status).toBe(401);
    const row = await env.DB.prepare("SELECT encrypted_access_token, encrypted_refresh_token FROM users WHERE id = ?").bind(editorUser.id).first();
    expect(row).toEqual({ encrypted_access_token: null, encrypted_refresh_token: null });
  });

  it("does not restore Google tokens after account disable during refresh", async () => {
    const env = testEnv();
    await env.DB.prepare("UPDATE users SET disabled_at = datetime('now'), encrypted_access_token = NULL, encrypted_refresh_token = NULL WHERE id = ?").bind(user.id).run();
    await expect(updateUserTokens(env, user.id, { encryptedAccessToken: "dummy-encrypted", encryptedRefreshToken: "dummy-refresh", tokenExpiresAt: 9999999999 })).rejects.toThrow("Google account must be reauthorized");
    expect(await env.DB.prepare("SELECT encrypted_access_token, encrypted_refresh_token FROM users WHERE id = ?").bind(user.id).first()).toEqual({ encrypted_access_token: null, encrypted_refresh_token: null });
  });
});
