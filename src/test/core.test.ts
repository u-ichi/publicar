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

  it("exposes the required Cloudflare bindings in the Workers runtime", async () => {
    const localEnv = testEnv();

    expect(localEnv.DB).toBeTruthy();
    expect(localEnv.SESSIONS).toBeTruthy();
    expect(localEnv.CACHE_BUCKET).toBeTruthy();
  });

  it("responds to health checks", async () => {
    const response = await app.fetch(new Request("http://localhost/health"), testEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      devMode: true
    });
  });

  it("serves app icon assets without authentication", async () => {
    const response = await app.fetch(new Request("http://localhost/favicon.svg"), testEnv());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("image/svg+xml");
    expect(await response.text()).toContain("#2563eb");
  });

  it("serves the web app manifest without authentication", async () => {
    const response = await app.fetch(new Request("http://localhost/site.webmanifest"), testEnv());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/manifest+json");
    await expect(response.json()).resolves.toMatchObject({
      name: "publicar",
      theme_color: "#2563eb"
    });
  });

  it("renders the login page at the root route when unauthenticated", async () => {
    const response = await app.fetch(new Request("http://localhost/"), testEnv());

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("publicar");
    expect(html).toContain("/auth/login");
    expect(html).toContain('href="/favicon.svg"');
    expect(html).toContain('href="/site.webmanifest"');
    expect(html).toContain('src="/logo-mark.svg"');
  });

  it("returns 401 for unauthenticated API requests", async () => {
    const response = await app.fetch(new Request("http://localhost/api/v1/whoami"), testEnv());

    expect(response.status).toBe(401);
  });

  it("redirects unauthenticated browser API requests to login", async () => {
    const response = await app.fetch(
      new Request("http://localhost/api/v1/whoami", {
        headers: { Accept: "text/html" }
      }),
      testEnv()
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/auth/login");
  });

  it("returns llms.txt without authentication", async () => {
    const response = await app.fetch(new Request("http://localhost/llms.txt"), testEnv());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/plain");
    const text = await response.text();
    expect(text).toContain("publicar");
    expect(text).toContain("Authorization: Bearer");
    expect(text).toContain("/api/v1/openapi.json");
  });

  it("returns the OpenAPI spec without authentication", async () => {
    const response = await app.fetch(new Request("http://localhost/api/v1/openapi.json"), testEnv());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const json = (await response.json()) as {
      openapi: string;
      info: { title: string };
      paths: Record<string, unknown>;
      components: { securitySchemes: { bearerAuth?: unknown } };
    };
    expect(json.openapi).toBe("3.1.0");
    expect(json.info.title).toBe("publicar API");
    expect(json.paths["/api/v1/projects"]).toBeDefined();
    expect(json.paths["/api/v1/api-keys"]).toBeDefined();
    expect(json.components.securitySchemes.bearerAuth).toBeDefined();
  });

  it("sets authenticated users on the request context", async () => {
    const localEnv = testEnv();
    const cookie = await createSession(localEnv, user);
    const response = await app.fetch(
      new Request("http://localhost/api/v1/whoami", {
        headers: { Cookie: cookie }
      }),
      localEnv
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ user });
  });

});
