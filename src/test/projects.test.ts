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

  it("renders the project dashboard at the root route when authenticated", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Dashboard Project",
      alias: "dashboard-project",
      visibility: "domain"
    });

    const response = await app.fetch(
      new Request("http://localhost/", {
        headers: { Cookie: cookie }
      }),
      localEnv
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(user.email);
    expect(html).toContain("Dashboard Project");
    expect(html).toContain("プロジェクトを検索");
    expect(html).toContain("表示モード");
    expect(html).toContain("data-view-mode=\"grid\"");
    expect(html).toContain("data-view-mode=\"list\"");
    expect(html).toContain("aria-label=\"カード表示\"");
    expect(html).toContain("aria-label=\"リスト表示\"");
    expect(html).not.toContain(">カード</button>");
    expect(html).not.toContain(">リスト</button>");
    expect(html).toContain("id=\"project-list\"");
    expect(html).toContain(`/projects/${project.id}`);
    expect(html).toContain("/dashboard-project");
    const helperIndex = html.indexOf("function qs");
    const dashboardScriptIndex = html.indexOf('qs("#project-search")');
    expect(helperIndex).toBeGreaterThan(-1);
    expect(dashboardScriptIndex).toBeGreaterThan(helperIndex);
  });

  it("renders the project detail tabs for project members", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv, avatarUser);
    const project = await createProject(localEnv, avatarUser, {
      title: "Detail Project",
      alias: "detail-project",
      visibility: "domain"
    });
    await updateProject(localEnv, project.id, { driveFolderId: "drive_folder_detail" });
    await upsertProjectFile(localEnv, {
      projectId: project.id,
      path: "index.html",
      driveFileId: "drive_file_detail",
      driveOwnerUserId: avatarUser.id,
      sizeBytes: 32,
      contentHash: "hash",
      mimeType: "text/html",
      driveModifiedTime: "2026-06-19T00:00:00.000Z",
      cacheEtag: null
    });

    const response = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        headers: { Cookie: cookie }
      }),
      localEnv
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Detail Project");
    expect(html).toContain("ファイル");
    expect(html).toContain("設定");
    expect(html).toContain("メンバー");
    expect(html).toContain("デプロイ履歴");
    expect(html).toContain("コメント履歴");
    expect(html).toContain("/detail-project");
    expect(html).toContain("https://drive.google.com/drive/folders/drive_folder_detail");
    expect(html).toContain("Google Drive");
    expect(html).toContain("Open");
    expect(html).not.toContain("プレビュー");
    expect(html).toContain("index.html");
    expect(html).toContain(`/projects/${project.id}/review?path=index.html`);
    expect(html).toContain("remove-file");
    expect(html).toContain("プロジェクトを削除");
    expect(html).toContain("delete-project");
    expect(html).toContain("実行者");
    expect(html).toContain(user.email);
    expect(html).toContain('class="user-identity-name">Test User</span>');
    expect(html).toContain('class="user-identity-email">user@example.com</span>');
    expect(html).not.toContain("Test User &lt;user@example.com&gt;");
    expect(html).toContain('src="https://example.com/avatar.png"');
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain('role: "editor"');
    expect(html).not.toContain('<option value="viewer"');
    expect(html).toContain("function activateTab");
    expect(html).toContain("userIdentityNode(log.userName, log.userEmail, log.userAvatarUrl)");
    expect(html).toContain("/comment-threads?limit=50&status=");
    expect(html).toContain("commentReviewUrl(thread)");
    expect(html).toContain("appendCommentHistoryItem(list, thread)");
    expect(html).toContain("appendCommentHistoryEvents(item, thread)");
    expect(html).toContain("sortCommentEventsForDisplay(thread.events)");
    expect(html).toContain("ステータスを ");
    expect(html).toContain("id=\"comment-history-status\"");
    expect(html).toContain("class=\"comment-history-list\"");
    expect(html).toContain("#comment-\" + encodeURIComponent(thread.id)");
    expect(html).toContain('reloadToTab("members")');
    const helperIndex = html.indexOf("function qs");
    const detailScriptIndex = html.indexOf('qsa(".tab")');
    expect(helperIndex).toBeGreaterThan(-1);
    expect(detailScriptIndex).toBeGreaterThan(helperIndex);
  });

  it("returns avatar URLs in access logs for project members", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv, avatarUser);
    const project = await createProject(localEnv, avatarUser, {
      title: "Access Log Project",
      alias: "access-log-project",
      visibility: "domain"
    });
    await localEnv.DB.prepare(
      "INSERT INTO access_logs (id, project_id, user_id, path, accessed_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind("alog_1", project.id, avatarUser.id, "index.html", "2026-06-20 10:00:00")
      .run();

    const response = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/access-logs?limit=10`, {
        headers: { Cookie: cookie }
      }),
      localEnv
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      logs: [
        {
          userId: avatarUser.id,
          userEmail: avatarUser.email,
          userName: avatarUser.name,
          userAvatarUrl: avatarUser.avatarUrl,
          path: "index.html"
        }
      ],
      nextCursor: null
    });
  });

  it("creates and lists projects for the authenticated user", async () => {
    const localEnv = testEnv({ DEFAULT_VISIBILITY: "domain" });
    const cookie = await authCookie(localEnv);
    const createResponse = await app.fetch(
      new Request("http://localhost/api/v1/projects", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          title: "Monthly Report",
          alias: "monthly-report"
        })
      }),
      localEnv
    );

    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as {
      project: { alias: string; role: string; visibility: string; allowedDomains: string[] };
    };
    expect(created.project).toMatchObject({
      alias: "monthly-report",
      role: "owner",
      visibility: "domain",
      allowedDomains: ["example.com"]
    });

    const listResponse = await app.fetch(
      new Request("http://localhost/api/v1/projects", {
        headers: { Cookie: cookie }
      }),
      localEnv
    );
    const listed = (await listResponse.json()) as { projects: Array<{ alias: string }> };
    expect(listed.projects.map((project) => project.alias)).toEqual(["monthly-report"]);
  });

  it("rejects invalid project aliases and file paths", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const createResponse = await app.fetch(
      new Request("http://localhost/api/v1/projects", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          title: "Bad",
          alias: "../bad"
        })
      }),
      localEnv
    );
    expect(createResponse.status).toBe(400);

    const reservedAliasResponse = await app.fetch(
      new Request("http://localhost/api/v1/projects", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          title: "Reserved",
          alias: "auth"
        })
      }),
      localEnv
    );
    expect(reservedAliasResponse.status).toBe(400);

    const project = await createProject(localEnv, user, {
      title: "Deploy Target",
      alias: "deploy-target",
      visibility: "public"
    });
    const deployResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/deploy?path=../index.html`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "text/html"
        },
        body: "<h1>bad</h1>"
      }),
      localEnv
    );
    expect(deployResponse.status).toBe(400);
  });

  it("updates project aliases and rejects reserved or duplicate aliases", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Alias Target",
      alias: "alias-target",
      visibility: "public"
    });
    await createProject(localEnv, user, {
      title: "Alias Taken",
      alias: "alias-taken",
      visibility: "public"
    });

    const updateResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}`, {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          alias: "alias-renamed",
          title: "Alias Renamed"
        })
      }),
      localEnv
    );
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toMatchObject({
      ok: true,
      project: { alias: "alias-renamed", title: "Alias Renamed" },
      url: "http://localhost/alias-renamed/"
    });

    const reservedResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}`, {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ alias: "auth" })
      }),
      localEnv
    );
    expect(reservedResponse.status).toBe(400);

    const duplicateResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}`, {
        method: "PATCH",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ alias: "alias-taken" })
      }),
      localEnv
    );
    expect(duplicateResponse.status).toBe(409);
  });

  it("lists project files for project members only", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    await seedUser(localEnv, editorUser);
    const project = await createProject(localEnv, user, {
      title: "Files Target",
      alias: "files-target",
      visibility: "public"
    });
    await upsertProjectFile(localEnv, {
      projectId: project.id,
      path: "index.html",
      driveFileId: "drive_file_files",
      driveOwnerUserId: user.id,
      sizeBytes: 64,
      contentHash: "hash",
      mimeType: "text/html",
      driveModifiedTime: null,
      cacheEtag: null
    });

    const memberResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/files`, {
        headers: { Cookie: cookie }
      }),
      localEnv
    );
    expect(memberResponse.status).toBe(200);
    const listed = (await memberResponse.json()) as { files: Array<{ path: string; deployerEmail: string | null }> };
    expect(listed.files.map((file) => file.path)).toEqual(["index.html"]);
    expect(listed.files[0]?.deployerEmail).toBe(user.email);

    const otherCookie = await createSession(localEnv, editorUser);
    const otherResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/files`, {
        headers: { Cookie: otherCookie }
      }),
      localEnv
    );
    expect(otherResponse.status).toBe(404);
  });

  it("deletes a project file from Drive, R2, and D1", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Delete File Target",
      alias: "delete-file-target",
      visibility: "public"
    });
    await upsertProjectFile(localEnv, {
      projectId: project.id,
      path: "index.html",
      driveFileId: "drive_file_delete",
      driveOwnerUserId: user.id,
      sizeBytes: 18,
      contentHash: "hash",
      mimeType: "text/html",
      driveModifiedTime: null,
      cacheEtag: null
    });
    await localEnv.CACHE_BUCKET.put(`projects/${project.id}/index.html`, "<h1>Cached</h1>", {
      httpMetadata: { contentType: "text/html" }
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      expect(url.pathname).toBe("/drive/v3/files/drive_file_delete");
      expect(init?.method).toBe("PATCH");
      await expect(new Response(init?.body).json()).resolves.toEqual({ trashed: true });
      return jsonResponse({ id: "drive_file_delete", trashed: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const deleteResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/files?path=index.html`, {
        method: "DELETE",
        headers: { Cookie: cookie }
      }),
      localEnv
    );

    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({ ok: true, deleted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(localEnv.CACHE_BUCKET.get(`projects/${project.id}/index.html`)).resolves.toBeNull();
    const row = await localEnv.DB.prepare("SELECT id FROM project_files WHERE project_id = ? AND path = ?")
      .bind(project.id, "index.html")
      .first();
    expect(row).toBeNull();

    const serveResponse = await app.fetch(new Request("http://localhost/delete-file-target/"), localEnv);
    expect(serveResponse.status).toBe(404);
  });

  it("treats repeated project file deletes as successful cache cleanup", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Repeated Delete Target",
      alias: "repeated-delete-target",
      visibility: "public"
    });
    await localEnv.CACHE_BUCKET.put(`projects/${project.id}/index.html`, "<h1>Stale</h1>", {
      httpMetadata: { contentType: "text/html" }
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const deleteResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/files?path=index.html`, {
        method: "DELETE",
        headers: { Cookie: cookie }
      }),
      localEnv
    );

    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({ ok: true, deleted: false });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(localEnv.CACHE_BUCKET.get(`projects/${project.id}/index.html`)).resolves.toBeNull();
  });

  it("deletes a project from Drive, R2, and D1", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Delete Project Target",
      alias: "delete-project-target",
      visibility: "public"
    });
    await updateProject(localEnv, project.id, { driveFolderId: "drive_folder_delete_project" });
    await upsertProjectFile(localEnv, {
      projectId: project.id,
      path: "index.html",
      driveFileId: "drive_file_delete_project",
      driveOwnerUserId: user.id,
      sizeBytes: 18,
      contentHash: "hash",
      mimeType: "text/html",
      driveModifiedTime: null,
      cacheEtag: null
    });
    await localEnv.CACHE_BUCKET.put(`projects/${project.id}/index.html`, "<h1>Cached</h1>", {
      httpMetadata: { contentType: "text/html" }
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      expect(url.pathname).toBe("/drive/v3/files/drive_folder_delete_project");
      expect(init?.method).toBe("PATCH");
      await expect(new Response(init?.body).json()).resolves.toEqual({ trashed: true });
      return jsonResponse({ id: "drive_folder_delete_project", trashed: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const deleteResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}`, {
        method: "DELETE",
        headers: { Cookie: cookie }
      }),
      localEnv
    );

    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({ ok: true, deleted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(localEnv.CACHE_BUCKET.get(`projects/${project.id}/index.html`)).resolves.toBeNull();
    const projectRow = await localEnv.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(project.id).first();
    const fileRow = await localEnv.DB.prepare("SELECT id FROM project_files WHERE project_id = ?").bind(project.id).first();
    expect(projectRow).toBeNull();
    expect(fileRow).toBeNull();
  });

});
