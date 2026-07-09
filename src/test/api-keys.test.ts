import { zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../auth/session";
import { upsertProjectFile } from "../db/project-files";
import { createProject, updateProject, upsertProjectMember } from "../db/projects";
import app from "../index";
import { getValidAccessToken } from "../lib/token-refresh";
import { authCookie, avatarUser, editorUser, jsonResponse, mockDriveUploads, resetDatabase, seedUser, testEnv, user, type Env } from "./helpers";

describe("publicar worker", () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    await resetDatabase(testEnv());
  });

  it("creates API keys for the authenticated user", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);

    const response = await app.fetch(
      new Request("http://localhost/api/v1/api-keys", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ name: "test-key" })
      }),
      localEnv
    );

    expect(response.status).toBe(201);
    const json = (await response.json()) as {
      ok: boolean;
      raw_key: string;
      api_key: { name: string; keyPrefix: string; scopes: string[]; keyHash?: string };
    };
    expect(json.ok).toBe(true);
    expect(json.raw_key).toMatch(/^pub_/);
    expect(json.api_key.name).toBe("test-key");
    expect(json.api_key.keyPrefix).toMatch(/^pub_/);
    expect(json.api_key.scopes).toEqual(["read", "write", "deploy"]);
    expect(json.api_key).not.toHaveProperty("keyHash");
  });

  it("creates API keys with custom scopes", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);

    const response = await app.fetch(
      new Request("http://localhost/api/v1/api-keys", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ name: "read-only", scopes: ["read"] })
      }),
      localEnv
    );

    expect(response.status).toBe(201);
    const json = (await response.json()) as { api_key: { scopes: string[] } };
    expect(json.api_key.scopes).toEqual(["read"]);
  });

  it("rejects invalid API key create requests", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);

    const missingNameResponse = await app.fetch(
      new Request("http://localhost/api/v1/api-keys", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      }),
      localEnv
    );
    expect(missingNameResponse.status).toBe(400);

    const invalidScopesResponse = await app.fetch(
      new Request("http://localhost/api/v1/api-keys", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ name: "bad", scopes: ["admin"] })
      }),
      localEnv
    );
    expect(invalidScopesResponse.status).toBe(400);
  });

  it("lists API keys without exposing raw keys or hashes", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    await app.fetch(
      new Request("http://localhost/api/v1/api-keys", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ name: "list-test" })
      }),
      localEnv
    );

    const response = await app.fetch(
      new Request("http://localhost/api/v1/api-keys", {
        headers: { Cookie: cookie }
      }),
      localEnv
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      api_keys: Array<{ id: string; name: string; rawKey?: string; keyHash?: string }>;
    };
    const key = json.api_keys.find((item) => item.name === "list-test");
    expect(key).toBeDefined();
    expect(key).not.toHaveProperty("rawKey");
    expect(key).not.toHaveProperty("keyHash");
  });

  it("deletes only the authenticated user's API key", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const createResponse = await app.fetch(
      new Request("http://localhost/api/v1/api-keys", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ name: "to-delete" })
      }),
      localEnv
    );
    const created = (await createResponse.json()) as { api_key: { id: string } };

    const deleteResponse = await app.fetch(
      new Request(`http://localhost/api/v1/api-keys/${created.api_key.id}`, {
        method: "DELETE",
        headers: { Cookie: cookie }
      }),
      localEnv
    );

    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({ ok: true });

    const listResponse = await app.fetch(
      new Request("http://localhost/api/v1/api-keys", {
        headers: { Cookie: cookie }
      }),
      localEnv
    );
    const listed = (await listResponse.json()) as { api_keys: Array<{ id: string }> };
    expect(listed.api_keys.find((apiKey) => apiKey.id === created.api_key.id)).toBeUndefined();
  });

  it("returns 404 when deleting another user's API key", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const createResponse = await app.fetch(
      new Request("http://localhost/api/v1/api-keys", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ name: "user-key" })
      }),
      localEnv
    );
    const created = (await createResponse.json()) as { api_key: { id: string } };
    const otherCookie = await authCookie(localEnv, {
      id: "user_3",
      googleId: "google_3",
      email: "other@example.com",
      name: "Other User",
      avatarUrl: null
    });

    const deleteResponse = await app.fetch(
      new Request(`http://localhost/api/v1/api-keys/${created.api_key.id}`, {
        method: "DELETE",
        headers: { Cookie: otherCookie }
      }),
      localEnv
    );

    expect(deleteResponse.status).toBe(404);
  });

  it("requires authentication for API key routes", async () => {
    const response = await app.fetch(new Request("http://localhost/api/v1/api-keys"), testEnv());

    expect(response.status).toBe(401);
  });

  async function createTestApiKey(localEnv: Env, cookie: string, name: string, scopes?: string[]): Promise<string> {
    const body: { name: string; scopes?: string[] } = { name };
    if (scopes) {
      body.scopes = scopes;
    }
    const response = await app.fetch(
      new Request("http://localhost/api/v1/api-keys", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }),
      localEnv
    );
    const json = (await response.json()) as { raw_key: string };
    return json.raw_key;
  }

  it("authenticates API requests with an API key", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const rawKey = await createTestApiKey(localEnv, cookie, "whoami-test");

    const response = await app.fetch(
      new Request("http://localhost/api/v1/whoami", {
        headers: { Authorization: `Bearer ${rawKey}` }
      }),
      localEnv
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as { user: { email: string } };
    expect(json.user.email).toBe(user.email);
  });

  it("rejects invalid API keys", async () => {
    const response = await app.fetch(
      new Request("http://localhost/api/v1/whoami", {
        headers: { Authorization: "Bearer pub_invalid_key_here" }
      }),
      testEnv()
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "invalid_api_key" });
  });

  it("rejects expired API keys", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const createResponse = await app.fetch(
      new Request("http://localhost/api/v1/api-keys", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ name: "expired", expires_at: "2020-01-01T00:00:00Z" })
      }),
      localEnv
    );
    const { raw_key: rawKey } = (await createResponse.json()) as { raw_key: string };

    const response = await app.fetch(
      new Request("http://localhost/api/v1/whoami", {
        headers: { Authorization: `Bearer ${rawKey}` }
      }),
      localEnv
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "api_key_expired" });
  });

  it("keeps session authentication working after auth resolution", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);

    const response = await app.fetch(
      new Request("http://localhost/api/v1/whoami", {
        headers: { Cookie: cookie }
      }),
      localEnv
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as { user: { email: string } };
    expect(json.user.email).toBe(user.email);
  });

  it("updates last_used_at on API key access", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const rawKey = await createTestApiKey(localEnv, cookie, "last-used-test");

    const response = await app.fetch(
      new Request("http://localhost/api/v1/whoami", {
        headers: { Authorization: `Bearer ${rawKey}` }
      }),
      localEnv
    );
    expect(response.status).toBe(200);

    const listResponse = await app.fetch(
      new Request("http://localhost/api/v1/api-keys", {
        headers: { Cookie: cookie }
      }),
      localEnv
    );
    const { api_keys: apiKeys } = (await listResponse.json()) as {
      api_keys: Array<{ name: string; lastUsedAt: string | null }>;
    };
    const key = apiKeys.find((apiKey) => apiKey.name === "last-used-test");
    expect(key?.lastUsedAt).not.toBeNull();
  });

  it("rejects API key deploys without the deploy scope", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const rawKey = await createTestApiKey(localEnv, cookie, "read-only-deploy", ["read"]);
    const project = await createProject(localEnv, user, {
      title: "Scope Reject",
      alias: "scope-reject",
      visibility: "public"
    });
    const fetchMock = mockDriveUploads();

    const response = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/deploy?path=index.html`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "text/html"
        },
        body: "<h1>Blocked</h1>"
      }),
      localEnv
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "insufficient_scope", required: "deploy" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows API key deploys with the deploy scope", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const rawKey = await createTestApiKey(localEnv, cookie, "deploy-scope", ["read", "write", "deploy"]);
    const project = await createProject(localEnv, user, {
      title: "Scope Deploy",
      alias: "scope-deploy",
      visibility: "public"
    });
    const fetchMock = mockDriveUploads();

    const response = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/deploy?path=index.html`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "text/html"
        },
        body: "<h1>Deployed</h1>"
      }),
      localEnv
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, entry: "index.html" });
    expect(fetchMock).toHaveBeenCalled();
  });
});
