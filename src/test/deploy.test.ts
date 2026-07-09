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

  it("blocks production deploys until TEAM_DRIVE_ID is configured", async () => {
    const localEnv = testEnv({ DEV_MODE: "false", TEAM_DRIVE_ID: undefined });
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Production Target",
      alias: "production-target",
      visibility: "public"
    });

    const deployResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/deploy?path=index.html`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "text/html"
        },
        body: "<h1>blocked</h1>"
      }),
      localEnv
    );

    expect(deployResponse.status).toBe(503);
    await expect(deployResponse.json()).resolves.toEqual({ error: "team_drive_not_configured" });
  });

  it("returns a stable JSON error when the Google Drive API is disabled", async () => {
    const localEnv = testEnv({ DEV_MODE: "false", TEAM_DRIVE_ID: "team_drive" });
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Drive Disabled",
      alias: "drive-disabled",
      visibility: "public"
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: 403,
              message:
                "Google Drive API has not been used in project 000000000000 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=000000000000 then retry."
            }
          },
          403
        )
      )
    );

    const deployResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/deploy?path=index.html`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "text/html"
        },
        body: "<h1>blocked</h1>"
      }),
      localEnv
    );

    expect(deployResponse.status).toBe(503);
    await expect(deployResponse.json()).resolves.toEqual({ error: "google_drive_api_disabled" });
  });

  it("lets owners add an existing editor who can redeploy the project", async () => {
    const localEnv = testEnv();
    const ownerCookie = await authCookie(localEnv);
    await seedUser(localEnv, editorUser);
    const project = await createProject(localEnv, user, {
      title: "Team Site",
      alias: "team-site",
      visibility: "public"
    });

    const addMemberResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/members`, {
        method: "POST",
        headers: {
          Cookie: ownerCookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: editorUser.email,
          role: "editor"
        })
      }),
      localEnv
    );
    expect(addMemberResponse.status).toBe(201);
    await expect(addMemberResponse.json()).resolves.toMatchObject({
      ok: true,
      member: {
        userId: editorUser.id,
        role: "editor",
        email: editorUser.email
      }
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.pathname === "/drive/v3/files" && init?.method === "POST") {
        return jsonResponse({ id: "drive_folder_team", name: "team-site", mimeType: "application/vnd.google-apps.folder" });
      }
      if (url.pathname === "/upload/drive/v3/files" && init?.method === "POST") {
        return jsonResponse({
          id: "drive_file_team",
          name: "index.html",
          mimeType: "text/html",
          size: "18",
          modifiedTime: "2026-06-19T00:00:00.000Z"
        });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const editorCookie = await createSession(localEnv, editorUser);
    const deployResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/deploy?path=index.html`, {
        method: "POST",
        headers: {
          Cookie: editorCookie,
          "Content-Type": "text/html"
        },
        body: "<h1>Editor</h1>"
      }),
      localEnv
    );

    expect(deployResponse.status).toBe(200);
    await expect(deployResponse.json()).resolves.toMatchObject({ ok: true });
  });

  it("deploys a single file to Drive and serves it from R2 with sandboxed HTML headers", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Public Site",
      alias: "public-site",
      visibility: "public"
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.pathname === "/drive/v3/files" && init?.method === "POST") {
        return jsonResponse({ id: "drive_folder_1", name: "public-site", mimeType: "application/vnd.google-apps.folder" });
      }
      if (url.pathname === "/upload/drive/v3/files" && init?.method === "POST") {
        const headers = new Headers(init.headers);
        expect(headers.get("Content-Type")).toMatch(/^multipart\/related; boundary=publicar_/);
        await expect(new Response(init.body).text()).resolves.toContain("Content-Type: text/html");
        return jsonResponse({
          id: "drive_file_1",
          name: "index.html",
          mimeType: "text/html",
          size: "15",
          modifiedTime: "2026-06-19T00:00:00.000Z"
        });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const htmlBody = "<h1>Hello</h1>";

    const deployResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/deploy?path=index.html`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "text/html; charset=utf-8"
        },
        body: htmlBody
      }),
      localEnv
    );
    expect(deployResponse.status).toBe(200);
    await expect(deployResponse.json()).resolves.toMatchObject({ ok: true, entry: "index.html" });
    const deployEvent = await localEnv.DB.prepare(
      "SELECT deploy_type, path, files_count, total_size_bytes, content_hash FROM deploy_events WHERE project_id = ?"
    )
      .bind(project.id)
      .first<{ deploy_type: string; path: string | null; files_count: number; total_size_bytes: number; content_hash: string | null }>();
    expect(deployEvent).toMatchObject({
      deploy_type: "file",
      path: "index.html",
      files_count: 1,
      total_size_bytes: new TextEncoder().encode(htmlBody).byteLength
    });
    expect(deployEvent?.content_hash).toBeTruthy();

    const redirectResponse = await app.fetch(new Request("http://localhost/public-site"), localEnv);
    expect(redirectResponse.status).toBe(301);
    expect(redirectResponse.headers.get("Location")).toBe("http://localhost/public-site/");

    const serveResponse = await app.fetch(new Request("http://localhost/public-site/"), localEnv);
    expect(serveResponse.status).toBe(200);
    const csp = serveResponse.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("script-src 'unsafe-inline' https:");
    expect(csp).toContain("style-src 'unsafe-inline' https:");
    expect(csp).toContain("font-src data: https:");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("worker-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(serveResponse.headers.get("X-Content-Type-Options")).toBe("nosniff");
    await expect(serveResponse.text()).resolves.toBe("<h1>Hello</h1>");

    const authenticatedOpenResponse = await app.fetch(
      new Request("http://localhost/public-site/", {
        headers: { Cookie: cookie }
      }),
      localEnv
    );
    expect(authenticatedOpenResponse.status).toBe(200);
    const authenticatedOpenHtml = await authenticatedOpenResponse.text();
    expect(authenticatedOpenHtml).toContain("data-comment-mode-toggle");
    expect(authenticatedOpenHtml).toContain('src="about:blank" data-review-src="/public-site/index.html?__publicar_review=1"');
    expect(authenticatedOpenHtml).toContain("comment-workbench");
    expect(authenticatedOpenHtml).toContain("function clearActiveCommentSelection()");
    expect(authenticatedOpenHtml).toContain("range.cloneRange()");
    expect(authenticatedOpenHtml).toContain("textNodesIn(block, true)");
    expect(authenticatedOpenHtml).toContain("function patchFrameHistorySync()");
    expect(authenticatedOpenHtml).toContain("function patchParentHistorySync()");
    expect(authenticatedOpenHtml).toContain("function preferParentRoute()");
    expect(authenticatedOpenHtml).toContain("function rememberActiveComment(thread)");
    expect(authenticatedOpenHtml).toContain("function restoreActiveCommentForRoute(hash, scrollCard = false)");
    expect(authenticatedOpenHtml).toContain("lastActiveCommentByFrameHash.set(hash, thread.id)");
    expect(authenticatedOpenHtml).toContain("comments.find((item) => threadFrameHash(item) === hash)");
    expect(authenticatedOpenHtml).toContain("function storedAnchorMatchesBlock(block, start, end, anchor, thread)");
    expect(authenticatedOpenHtml).toContain("if (anchorHasTextContext(anchor, thread) && renderedMatch) {");
    expect(authenticatedOpenHtml).toContain("const frameHashChanged = isFrameRouteHash(hash) && hash !== lastObservedFrameHash");
    expect(authenticatedOpenHtml).toContain("lastObservedFrameHash = frameHash");
    expect(authenticatedOpenHtml).toContain("function renderCurrentRouteHighlights(scrollCard = false)");
    expect(authenticatedOpenHtml).toContain("renderCurrentRouteHighlights(true)");
    expect(authenticatedOpenHtml).toContain("highlightObserver = new MutationObserver(() => scheduleRouteHighlightRender())");
    expect(authenticatedOpenHtml).toContain("if (frameHash === hash) {\n    clearSelectionDraft();\n    renderCurrentRouteHighlights(true);\n    return;\n  }");
    expect(authenticatedOpenHtml).toContain("function reviewFrameInitialSrc()");
    expect(authenticatedOpenHtml).toContain("startReviewFrame()");
    expect(authenticatedOpenHtml).toContain("window.addEventListener(\"pageshow\", reconcileRouteState)");
    expect(authenticatedOpenHtml).toContain("document.addEventListener(\"visibilitychange\", handleVisibilityRouteResume)");
    const inlineScripts = [...authenticatedOpenHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");
    expect(inlineScripts.length).toBeGreaterThan(0);
    for (const script of inlineScripts) {
      expect(() => new Function(script)).not.toThrow();
    }

    const rawOpenResponse = await app.fetch(
      new Request("http://localhost/public-site/?__publicar_raw=1", {
        headers: { Cookie: cookie }
      }),
      localEnv
    );
    expect(rawOpenResponse.status).toBe(200);
    await expect(rawOpenResponse.text()).resolves.toBe("<h1>Hello</h1>");

    const reviewFrameResponse = await app.fetch(
      new Request("http://localhost/public-site/index.html?__publicar_review=1", {
        headers: { Cookie: cookie }
      }),
      localEnv
    );
    expect(reviewFrameResponse.status).toBe(200);
    const reviewFrameCsp = reviewFrameResponse.headers.get("Content-Security-Policy") ?? "";
    expect(reviewFrameCsp).toContain("sandbox allow-scripts allow-same-origin");
    expect(reviewFrameCsp).toContain("script-src 'unsafe-inline' https:");
    expect(reviewFrameCsp).toContain("frame-ancestors 'self'");
    expect(reviewFrameCsp).not.toContain("frame-ancestors 'none'");
  });

  it("deploys a ZIP file with multiple files", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Zip Site",
      alias: "zip-site",
      visibility: "public"
    });
    mockDriveUploads();
    const encoder = new TextEncoder();
    const indexHtml = "<html><body>Hello</body></html>";
    const styleCss = "body { color: red; }";
    const scriptJs = "console.log('hi');";
    const zipData = zipSync({
      "index.html": encoder.encode(indexHtml),
      "assets/style.css": encoder.encode(styleCss),
      "assets/script.js": encoder.encode(scriptJs)
    });

    const deployResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/deploy?name=site.zip`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/zip"
        },
        body: zipData
      }),
      localEnv
    );

    expect(deployResponse.status).toBe(200);
    await expect(deployResponse.json()).resolves.toMatchObject({
      ok: true,
      files: 3,
      entry_path: "index.html"
    });
    const rows = await localEnv.DB.prepare("SELECT path, mime_type FROM project_files WHERE project_id = ? ORDER BY path ASC")
      .bind(project.id)
      .all<{ path: string; mime_type: string }>();
    expect(rows.results).toEqual([
      { path: "assets/script.js", mime_type: "text/javascript" },
      { path: "assets/style.css", mime_type: "text/css" },
      { path: "index.html", mime_type: "text/html" }
    ]);
    const deployEvent = await localEnv.DB.prepare(
      "SELECT deploy_type, path, files_count, total_size_bytes, content_hash FROM deploy_events WHERE project_id = ?"
    )
      .bind(project.id)
      .first<{ deploy_type: string; path: string | null; files_count: number; total_size_bytes: number; content_hash: string | null }>();
    expect(deployEvent).toMatchObject({
      deploy_type: "zip",
      path: null,
      files_count: 3,
      total_size_bytes: encoder.encode(indexHtml).byteLength + encoder.encode(styleCss).byteLength + encoder.encode(scriptJs).byteLength,
      content_hash: null
    });
    await expect(localEnv.CACHE_BUCKET.get(`projects/${project.id}/index.html`)).resolves.toBeTruthy();

    const redirectResponse = await app.fetch(new Request("http://localhost/zip-site"), localEnv);
    expect(redirectResponse.status).toBe(301);
    expect(redirectResponse.headers.get("Location")).toBe("http://localhost/zip-site/");

    const htmlResponse = await app.fetch(new Request("http://localhost/zip-site/"), localEnv);
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers.get("Content-Type")).toContain("text/html");

    const assetResponse = await app.fetch(new Request("http://localhost/zip-site/assets/style.css"), localEnv);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("Content-Type")).toContain("text/css");
    expect(assetResponse.headers.get("Content-Security-Policy")).toBeNull();
    await expect(assetResponse.text()).resolves.toBe("body { color: red; }");
  });

  it("rejects empty ZIP deploys", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Empty Zip",
      alias: "empty-zip",
      visibility: "public"
    });

    const deployResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/deploy?name=empty.zip`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/zip"
        },
        body: zipSync({})
      }),
      localEnv
    );

    expect(deployResponse.status).toBe(400);
    await expect(deployResponse.json()).resolves.toEqual({ error: "empty_zip" });
  });

  it("filters ZIP OS metadata entries", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Mac Zip",
      alias: "mac-zip",
      visibility: "public"
    });
    mockDriveUploads();
    const encoder = new TextEncoder();
    const zipData = zipSync({
      "index.html": encoder.encode("<html>OK</html>"),
      "__MACOSX/._index.html": encoder.encode("metadata"),
      ".DS_Store": encoder.encode("store")
    });

    const deployResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/deploy?name=mac.zip`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/zip"
        },
        body: zipData
      }),
      localEnv
    );

    expect(deployResponse.status).toBe(200);
    await expect(deployResponse.json()).resolves.toMatchObject({ ok: true, files: 1, entry_path: "index.html" });
    const rows = await localEnv.DB.prepare("SELECT path FROM project_files WHERE project_id = ?")
      .bind(project.id)
      .all<{ path: string }>();
    expect(rows.results.map((row) => row.path)).toEqual(["index.html"]);
  });

  it("determines ZIP entry_path from a single HTML file when index.html is absent", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Report Zip",
      alias: "report-zip",
      visibility: "public"
    });
    mockDriveUploads();
    const encoder = new TextEncoder();
    const zipData = zipSync({
      "report.html": encoder.encode("<html>Report</html>"),
      "data.json": encoder.encode("{}")
    });

    const deployResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/deploy?name=report.zip`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/zip"
        },
        body: zipData
      }),
      localEnv
    );

    expect(deployResponse.status).toBe(200);
    await expect(deployResponse.json()).resolves.toMatchObject({ ok: true, files: 2, entry_path: "report.html" });
    const updatedProject = await localEnv.DB.prepare("SELECT entry_path FROM projects WHERE id = ?")
      .bind(project.id)
      .first<{ entry_path: string }>();
    expect(updatedProject?.entry_path).toBe("report.html");
  });

  it("cleans files missing from a ZIP deploy", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Clean Zip",
      alias: "clean-zip",
      visibility: "public"
    });
    await updateProject(localEnv, project.id, { driveFolderId: "drive_folder_zip" });
    await upsertProjectFile(localEnv, {
      projectId: project.id,
      path: "stale.html",
      driveFileId: "drive_file_stale",
      driveOwnerUserId: user.id,
      sizeBytes: 16,
      contentHash: "hash",
      mimeType: "text/html",
      driveModifiedTime: null,
      cacheEtag: null
    });
    await localEnv.CACHE_BUCKET.put(`projects/${project.id}/stale.html`, "<h1>Stale</h1>", {
      httpMetadata: { contentType: "text/html" }
    });
    const fetchMock = mockDriveUploads();
    const encoder = new TextEncoder();
    const zipData = zipSync({
      "index.html": encoder.encode("<html>Fresh</html>")
    });

    const deployResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/deploy?name=clean.zip`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/zip"
        },
        body: zipData
      }),
      localEnv
    );

    expect(deployResponse.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({}),
      expect.objectContaining({ method: "PATCH" })
    );
    await expect(localEnv.CACHE_BUCKET.get(`projects/${project.id}/stale.html`)).resolves.toBeNull();
    const rows = await localEnv.DB.prepare("SELECT path FROM project_files WHERE project_id = ? ORDER BY path ASC")
      .bind(project.id)
      .all<{ path: string }>();
    expect(rows.results.map((row) => row.path)).toEqual(["index.html"]);
  });

});
