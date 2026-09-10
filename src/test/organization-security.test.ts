import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../auth/session";
import { updateUserTokens } from "../db/users";
import { createApiKey } from "../db/api-keys";
import { createProject } from "../db/projects";
import app from "../index";
import { editorUser, mockDriveUploads, resetDatabase, seedUser, testEnv, user } from "./helpers";

describe("organization security", () => {
  beforeEach(async () => { vi.unstubAllGlobals(); await resetDatabase(testEnv()); await seedUser(testEnv()); });

  it("does not let a read key issue another key or change visibility", async () => {
    const env = testEnv();
    const { rawKey } = await createApiKey(env, user.id, { name: "reader", scopes: ["read"] });
    const project = await createProject(env, user, { title: "Private", alias: "private-doc", visibility: "private" });
    for (const [method, path, body] of [
      ["POST", "/api/v1/api-keys", { name: "escaped" }],
      ["PATCH", `/api/v1/projects/${project.id}`, { visibility: "public" }]
    ] as const) {
      const response = await app.fetch(new Request(`http://localhost${path}`, {
        method, headers: { Authorization: `Bearer ${rawKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body)
      }), env);
      expect(response.status).toBe(403);
    }
  });

  it("rejects malformed stored key expiry", async () => {
    const env = testEnv();
    const { rawKey } = await createApiKey(env, user.id, { name: "invalid-expiry", scopes: ["read"], expiresAt: "invalid" });
    const response = await app.fetch(new Request("http://localhost/api/v1/whoami", { headers: { Authorization: `Bearer ${rawKey}` } }), env);
    expect(response.status).toBe(401);
  });

  it("restricts a deploy key to its project even when its owner owns both projects", async () => {
    const env = testEnv();
    const a = await createProject(env, user, { title: "A", alias: "project-a", visibility: "private" });
    const b = await createProject(env, user, { title: "B", alias: "project-b", visibility: "private" });
    const { rawKey, apiKey } = await createApiKey(env, user.id, { name: "A only", scopes: ["deploy"], projectId: a.id });
    const fetchMock = mockDriveUploads();
    const request = (path: string, method = "POST") => app.fetch(new Request(`http://localhost${path}`, {
      method, headers: { Authorization: `Bearer ${rawKey}`, "Content-Type": "text/html" }, ...(method === "GET" ? {} : { body: "<h1>A</h1>" })
    }), env);
    expect((await request(`/api/v1/projects/${b.id}/deploy`)).status).toBe(403);
    expect((await request(`/api/v1/projects/${b.id}`, "GET")).status).toBe(403);
    expect((await request("/api/v1/projects", "GET")).status).toBe(403);
    expect((await request(`/projects/${a.id}`, "GET")).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await request(`/api/v1/projects/${a.id}/deploy?path=index.html`)).status).toBe(200);
    await env.DB.prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ?").bind(apiKey.id).run();
    expect((await request(`/api/v1/projects/${a.id}/deploy`)).status).toBe(401);
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
