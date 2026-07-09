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

  it("falls back to Drive on R2 miss and returns 404 when Drive access is gone", async () => {
    const localEnv = testEnv();
    await seedUser(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Fallback Site",
      alias: "fallback-site",
      visibility: "public"
    });
    await upsertProjectFile(localEnv, {
      projectId: project.id,
      path: "index.html",
      driveFileId: "drive_file_missing",
      driveOwnerUserId: user.id,
      sizeBytes: 10,
      contentHash: "hash",
      mimeType: "text/html",
      driveModifiedTime: null,
      cacheEtag: null
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("missing", { status: 404 }))
    );

    const serveResponse = await app.fetch(new Request("http://localhost/fallback-site/"), localEnv);
    expect(serveResponse.status).toBe(404);
  });

  it("treats trashed Drive files as deleted on R2 miss", async () => {
    const localEnv = testEnv();
    await seedUser(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Trashed Site",
      alias: "trashed-site",
      visibility: "public"
    });
    await upsertProjectFile(localEnv, {
      projectId: project.id,
      path: "index.html",
      driveFileId: "drive_file_trashed",
      driveOwnerUserId: user.id,
      sizeBytes: 10,
      contentHash: "hash",
      mimeType: "text/html",
      driveModifiedTime: null,
      cacheEtag: null
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      expect(url.searchParams.get("alt")).toBeNull();
      return jsonResponse({
        id: "drive_file_trashed",
        name: "index.html",
        mimeType: "text/html",
        trashed: true
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const serveResponse = await app.fetch(new Request("http://localhost/trashed-site/"), localEnv);
    expect(serveResponse.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes expired Google access tokens without storing plaintext tokens", async () => {
    const localEnv = testEnv();
    await seedUser(localEnv, user, {
      accessToken: "expired-access-token",
      refreshToken: "refresh-token",
      tokenExpiresAt: Math.floor(Date.now() / 1000) - 10
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        expect(input.toString()).toBe("https://oauth.test/token");
        return jsonResponse({
          access_token: "fresh-access-token",
          refresh_token: "fresh-refresh-token",
          expires_in: 3600,
          token_type: "Bearer"
        });
      })
    );

    await expect(getValidAccessToken(localEnv, user.id)).resolves.toBe("fresh-access-token");
    const row = await localEnv.DB.prepare(
      "SELECT encrypted_access_token, encrypted_refresh_token FROM users WHERE id = ?"
    )
      .bind(user.id)
      .first<{ encrypted_access_token: string; encrypted_refresh_token: string }>();
    expect(row?.encrypted_access_token).not.toContain("fresh-access-token");
    expect(row?.encrypted_refresh_token).not.toContain("fresh-refresh-token");
  });

  it("adds noindex headers to link visibility project responses", async () => {
    const localEnv = testEnv();
    await seedUser(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Link Visibility",
      alias: "link-visibility",
      visibility: "link"
    });
    await upsertProjectFile(localEnv, {
      projectId: project.id,
      path: "index.html",
      driveFileId: "drive_file_link_visibility",
      driveOwnerUserId: user.id,
      sizeBytes: 18,
      contentHash: "hash",
      mimeType: "text/html",
      driveModifiedTime: null,
      cacheEtag: null
    });
    await localEnv.CACHE_BUCKET.put(`projects/${project.id}/index.html`, "<h1>Link</h1>", {
      httpMetadata: { contentType: "text/html" }
    });

    const response = await app.fetch(new Request("http://localhost/link-visibility/"), localEnv);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    await expect(response.text()).resolves.toBe("<h1>Link</h1>");
  });

});
