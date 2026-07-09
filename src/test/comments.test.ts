import { zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../auth/session";
import { upsertProjectFile } from "../db/project-files";
import { createProject, updateProject, upsertProjectMember } from "../db/projects";
import app from "../index";
import { getValidAccessToken } from "../lib/token-refresh";
import { authCookie, avatarUser, editorUser, jsonResponse, mockDriveUploads, resetDatabase, seedUser, testEnv, user, type Env } from "./helpers";

describe("CLI Auth Flow", () => {
  beforeEach(async () => {
    await resetDatabase(testEnv());
  });

  it("creates review comments for authenticated project viewers and notifies project owners", async () => {
    const localEnv = testEnv();
    const ownerCookie = await authCookie(localEnv, user);
    const project = await createProject(localEnv, user, {
      title: "Comment Target",
      alias: "comment-target",
      visibility: "private"
    });
    await upsertProjectFile(localEnv, {
      projectId: project.id,
      path: "index.html",
      driveFileId: "drive_file_comment_target",
      driveOwnerUserId: user.id,
      sizeBytes: 14,
      contentHash: "hash-comment",
      mimeType: "text/html",
      driveModifiedTime: "2026-06-20T00:00:00.000Z",
      cacheEtag: "etag-comment"
    });
    await localEnv.CACHE_BUCKET.put(`projects/${project.id}/index.html`, "<h1>Hello</h1>", {
      httpMetadata: { contentType: "text/html" }
    });
    const editorCookie = await authCookie(localEnv, editorUser);
    await upsertProjectMember(localEnv, { projectId: project.id, userId: editorUser.id, role: "editor" });

    const createResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/comments`, {
        method: "POST",
        headers: { Cookie: editorCookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "index.html",
          body: "ここを確認してください",
          anchor: { blockId: "auto-1", start: 0, end: 5, selectedText: "Hello", frameHash: "#admissions", frameUrl: "/comment-target/index.html#admissions" },
          actorKind: "ai",
          selected_text: "Hello",
          client_mutation_id: "comment-test-1"
        })
      }),
      localEnv
    );

    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { thread: { id: string; actorKind: string; author: { email: string } } };
    expect(created.thread.author.email).toBe(editorUser.email);
    expect(created.thread.actorKind).toBe("ai");

    const listResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/comments?path=index.html&status=all`, {
        headers: { Cookie: ownerCookie }
      }),
      localEnv
    );
    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()) as { threads: Array<{ body: string; actorKind: string; selectedText: string; anchor: Record<string, unknown> }> };
    expect(listed.threads).toMatchObject([{ body: "ここを確認してください", actorKind: "ai", selectedText: "Hello" }]);
    expect(listed.threads[0]?.anchor).toMatchObject({ frameHash: "#admissions", frameUrl: "/comment-target/index.html#admissions" });

    const notificationResponse = await app.fetch(
      new Request("http://localhost/api/v1/notifications?status=unread", {
        headers: { Cookie: ownerCookie }
      }),
      localEnv
    );
    expect(notificationResponse.status).toBe(200);
    const notifications = (await notificationResponse.json()) as { unreadCount: number; notifications: Array<{ url: string; body: string }> };
    expect(notifications.unreadCount).toBe(1);
    expect(notifications.notifications[0]?.url).toContain(`/projects/${project.id}/review?path=index.html`);
  });

  it("tracks actorKind for AI replies and rejects immutable actorKind patches", async () => {
    const localEnv = testEnv();
    const ownerCookie = await authCookie(localEnv, user);
    const project = await createProject(localEnv, user, {
      title: "Actor Kind",
      alias: "actor-kind",
      visibility: "private"
    });
    await upsertProjectFile(localEnv, {
      projectId: project.id,
      path: "index.html",
      driveFileId: "drive_file_actor_kind",
      driveOwnerUserId: user.id,
      sizeBytes: 14,
      contentHash: "hash-actor-kind",
      mimeType: "text/html",
      driveModifiedTime: "2026-06-20T00:00:00.000Z",
      cacheEtag: "etag-actor-kind"
    });

    const createResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/comments`, {
        method: "POST",
        headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "index.html",
          body: "人間のコメント",
          anchor: { blockId: "auto-1", start: 0, end: 5, selectedText: "Hello" },
          selected_text: "Hello"
        })
      }),
      localEnv
    );
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { thread: { id: string; actorKind: string } };
    expect(created.thread.actorKind).toBe("human");

    const replyResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/comments/${created.thread.id}/replies`, {
        method: "POST",
        headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ body: "HTML へ反映しました", actorKind: "ai" })
      }),
      localEnv
    );
    expect(replyResponse.status).toBe(201);
    const replied = (await replyResponse.json()) as { reply: { actorKind: string }; thread: { replies: Array<{ actorKind: string }> } };
    expect(replied.reply.actorKind).toBe("ai");
    expect(replied.thread.replies).toMatchObject([{ actorKind: "ai" }]);

    const invalidReplyResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/comments/${created.thread.id}/replies`, {
        method: "POST",
        headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ body: "invalid", actorKind: "bot" })
      }),
      localEnv
    );
    expect(invalidReplyResponse.status).toBe(400);

    const patchResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/comments/${created.thread.id}`, {
        method: "PATCH",
        headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ actorKind: "ai" })
      }),
      localEnv
    );
    expect(patchResponse.status).toBe(400);
  });

  it("lists project comment history for project members by updated time", async () => {
    const localEnv = testEnv();
    const ownerCookie = await authCookie(localEnv, user);
    const editorCookie = await authCookie(localEnv, editorUser);
    const project = await createProject(localEnv, user, {
      title: "Comment History",
      alias: "comment-history",
      visibility: "domain"
    });
    await upsertProjectMember(localEnv, { projectId: project.id, userId: editorUser.id, role: "editor" });
    for (const path of ["index.html", "guide.html", "removed.html"]) {
      await upsertProjectFile(localEnv, {
        projectId: project.id,
        path,
        driveFileId: `drive_file_${path}`,
        driveOwnerUserId: user.id,
        sizeBytes: 14,
        contentHash: `hash-${path}`,
        mimeType: "text/html",
        driveModifiedTime: "2026-06-20T00:00:00.000Z",
        cacheEtag: `etag-${path}`
      });
    }

    async function createComment(path: string, body: string, selectedText: string) {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/projects/${project.id}/comments`, {
          method: "POST",
          headers: { Cookie: editorCookie, "Content-Type": "application/json" },
          body: JSON.stringify({
            path,
            body,
            anchor: { blockId: "auto-1", start: 0, end: selectedText.length, selectedText, frameHash: "#target" },
            selected_text: selectedText
          })
        }),
        localEnv
      );
      expect(response.status).toBe(201);
      const payload = (await response.json()) as { thread: { id: string } };
      return payload.thread.id;
    }

    const olderId = await createComment("index.html", "古いコメント", "Hello");
    const latestId = await createComment("guide.html", "新しいコメント", "Guide");
    const removedId = await createComment("removed.html", "削除済みファイルのコメント", "Removed");
    await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/comments/${olderId}`, {
        method: "PATCH",
        headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "resolved" })
      }),
      localEnv
    );
    await localEnv.DB.batch([
      localEnv.DB.prepare("UPDATE comment_threads SET updated_at = ? WHERE id = ?").bind("2026-06-20 10:00:00", olderId),
      localEnv.DB.prepare("UPDATE comment_threads SET updated_at = ? WHERE id = ?").bind("2026-06-20 12:00:00", latestId),
      localEnv.DB.prepare("UPDATE comment_threads SET updated_at = ? WHERE id = ?").bind("2026-06-20 13:00:00", removedId),
      localEnv.DB.prepare("DELETE FROM project_files WHERE project_id = ? AND path = ?").bind(project.id, "removed.html")
    ]);

    const listResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/comment-threads?status=all&limit=1`, {
        headers: { Cookie: ownerCookie }
      }),
      localEnv
    );
    expect(listResponse.status).toBe(200);
    const firstPage = (await listResponse.json()) as {
      threads: Array<{
        id: string;
        path: string;
        body: string;
        selectedText: string;
        updatedAt: string;
        events: Array<{ kind: string; body: string; nextStatus: string | null; inferred: boolean }>;
      }>;
      nextCursor: string | null;
    };
    expect(firstPage.threads).toMatchObject([{ id: latestId, path: "guide.html", body: "新しいコメント", selectedText: "Guide" }]);
    expect(firstPage.threads[0]?.events).toMatchObject([{ kind: "comment_created", body: "新しいコメント", nextStatus: "open", inferred: true }]);
    expect(firstPage.nextCursor).toBeTruthy();

    const nextResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/comment-threads?status=all&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`, {
        headers: { Cookie: ownerCookie }
      }),
      localEnv
    );
    expect(nextResponse.status).toBe(200);
    const secondPage = (await nextResponse.json()) as {
      threads: Array<{ id: string; status: string; events: Array<{ kind: string; previousStatus: string | null; nextStatus: string | null; inferred: boolean }> }>;
      nextCursor: string | null;
    };
    expect(secondPage.threads).toMatchObject([{ id: olderId, status: "resolved" }]);
    expect(secondPage.threads[0]?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "comment_created", nextStatus: "open", inferred: true }),
        expect.objectContaining({ kind: "status_changed", previousStatus: "open", nextStatus: "resolved", inferred: false })
      ])
    );
    expect(secondPage.nextCursor).toBeNull();

    const openResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/comment-threads?status=open`, {
        headers: { Cookie: ownerCookie }
      }),
      localEnv
    );
    expect(openResponse.status).toBe(200);
    const openList = (await openResponse.json()) as { threads: Array<{ id: string }> };
    expect(openList.threads.map((thread) => thread.id)).toEqual([latestId]);

    const nonMemberResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/comment-threads`, {
        headers: { Cookie: await authCookie(localEnv, { ...editorUser, id: "user_nonmember", googleId: "google_nonmember", email: "nonmember@example.com" }) }
      }),
      localEnv
    );
    expect(nonMemberResponse.status).toBe(404);
  });

  it("serves authenticated review content from cached HTML without changing public HTML headers", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv, user);
    const project = await createProject(localEnv, user, {
      title: "Review Content",
      alias: "review-content",
      visibility: "link"
    });
    await upsertProjectFile(localEnv, {
      projectId: project.id,
      path: "index.html",
      driveFileId: "drive_file_review_content",
      driveOwnerUserId: user.id,
      sizeBytes: 29,
      contentHash: "hash-review",
      mimeType: "text/html",
      driveModifiedTime: "2026-06-20T00:00:00.000Z",
      cacheEtag: "etag-review"
    });
    await localEnv.CACHE_BUCKET.put(`projects/${project.id}/index.html`, "<h1>Review</h1><script>x()</script>", {
      httpMetadata: { contentType: "text/html" }
    });

    const reviewResponse = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/review-content?path=index.html`, {
        headers: { Cookie: cookie }
      }),
      localEnv
    );
    expect(reviewResponse.status).toBe(200);
    const reviewJson = (await reviewResponse.json()) as { html: string; file: { contentType: string } };
    expect(reviewJson.html).toContain("<script>x()</script>");
    expect(reviewJson.file.contentType).toBe("text/html");

    const reviewPageResponse = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/review?path=index.html`, {
        headers: { Cookie: cookie }
      }),
      localEnv
    );
    const reviewPageHtml = await reviewPageResponse.text();
    expect(reviewPageHtml).toContain('src="about:blank" data-review-src="/review-content/index.html?__publicar_review=1"');
    expect(reviewPageHtml).not.toContain("sandbox=");
    expect(reviewPageHtml).not.toContain("srcdoc");

    const publicResponse = await app.fetch(
      new Request("http://localhost/review-content/"),
      localEnv
    );
    expect(publicResponse.headers.get("Content-Security-Policy")).toContain("connect-src 'none'");
  });
});

describe("PR0 characterization tests", () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    await resetDatabase(testEnv());
  });

  const limitCases = [
    { label: "missing", query: "", expectedByFallback: true, expected: { comments: 100, commentThreads: 50, notifications: 50, accessLogs: 50 } },
    { label: "empty", query: "limit=", expectedByFallback: true, expected: { comments: 100, commentThreads: 50, notifications: 50, accessLogs: 50 } },
    { label: "zero", query: "limit=0", expectedByFallback: true, expected: { comments: 100, commentThreads: 50, notifications: 50, accessLogs: 50 } },
    { label: "negative", query: "limit=-1", expectedByFallback: false, expected: { comments: 1, commentThreads: 1, notifications: 1, accessLogs: 1 } },
    { label: "over max", query: "limit=101", expectedByFallback: false, expected: { comments: 100, commentThreads: 100, notifications: 100, accessLogs: 100 } },
    { label: "NaN", query: "limit=abc", expectedByFallback: true, expected: { comments: 100, commentThreads: 50, notifications: 50, accessLogs: 50 } }
  ];

  type LimitKey = keyof (typeof limitCases)[number]["expected"];
  type RetryScenario = "success" | "refresh-success" | "refresh-fails";
  type DriveOperation = "folder" | "upload" | "trash" | "download";

  async function seedProjectWithFile(localEnv: Env, input: { alias?: string; visibility?: "private" | "public"; driveOwnerUserId?: string | null } = {}) {
    const alias = input.alias ?? "test-file-project";
    const project = await createProject(localEnv, user, {
      title: alias,
      alias,
      visibility: input.visibility ?? "private"
    });
    await upsertProjectFile(localEnv, {
      projectId: project.id,
      path: "index.html",
      driveFileId: `drive_file_${alias}`,
      driveOwnerUserId: input.driveOwnerUserId ?? user.id,
      sizeBytes: 18,
      contentHash: `hash-${alias}`,
      mimeType: "text/html",
      driveModifiedTime: "2026-06-20T00:00:00.000Z",
      cacheEtag: null
    });
    return project;
  }

  it("escapes review path JSON inside inline scripts", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await seedProjectWithFile(localEnv, { alias: "review-script-escape" });

    const response = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/review?path=foo/bar%3C%2Fscript%3E.html`, {
        headers: { Cookie: cookie }
      }),
      localEnv
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('const reviewPath = "foo/bar\\u003c/script>.html";');
    expect(html).not.toContain('const reviewPath = "foo/bar</script>.html";');
    expect(html.match(/<script>/g)).toHaveLength(html.match(/<\/script>/g)?.length ?? 0);
  });

  async function seedLimitRows(localEnv: Env, route: LimitKey) {
    const cookie = await authCookie(localEnv);
    const project = await seedProjectWithFile(localEnv, { alias: `limit-${route}` });
    const statements = [];
    for (let i = 0; i < 105; i += 1) {
      const suffix = String(i).padStart(3, "0");
      if (route === "comments" || route === "commentThreads") {
        statements.push(
          localEnv.DB.prepare(
            `INSERT INTO comment_threads (
              id, project_id, path, author_user_id, body, anchor_json,
              selected_text, status, created_at, updated_at
            ) VALUES (?, ?, 'index.html', ?, ?, '{}', 'text', 'open', ?, ?)`
          ).bind(`thread_${route}_${suffix}`, project.id, user.id, `body ${suffix}`, `2026-06-20 10:${suffix.slice(1)}:00`, `2026-06-20 11:${suffix.slice(1)}:00`)
        );
      }
      if (route === "notifications") {
        statements.push(
          localEnv.DB.prepare(
            "INSERT INTO notification_events (id, project_id, actor_user_id, kind, title, body, url, created_at) VALUES (?, ?, ?, 'comment_created', ?, ?, ?, ?)"
          ).bind(`event_${suffix}`, project.id, user.id, `title ${suffix}`, `body ${suffix}`, `/projects/${project.id}/review`, `2026-06-20 10:${suffix.slice(1)}:00`),
          localEnv.DB.prepare(
            "INSERT INTO notification_deliveries (id, event_id, recipient_user_id, channel, status, created_at) VALUES (?, ?, ?, 'app', 'delivered', ?)"
          ).bind(`delivery_${suffix}`, `event_${suffix}`, user.id, `2026-06-20 10:${suffix.slice(1)}:00`)
        );
      }
      if (route === "accessLogs") {
        statements.push(
          localEnv.DB.prepare("INSERT INTO access_logs (id, project_id, user_id, path, accessed_at) VALUES (?, ?, ?, 'index.html', ?)")
            .bind(`log_${suffix}`, project.id, user.id, `2026-06-20 10:${suffix.slice(1)}:00`)
        );
      }
    }
    await localEnv.DB.batch(statements);
    return { cookie, project };
  }

  async function fetchLimitCount(localEnv: Env, route: LimitKey, query: string): Promise<number> {
    const { cookie, project } = await seedLimitRows(localEnv, route);
    const separator = query ? `?${query}` : "";
    const path =
      route === "comments"
        ? `/api/v1/projects/${project.id}/comments${separator}${query ? "&" : "?"}path=index.html&status=all`
        : route === "commentThreads"
          ? `/api/v1/projects/${project.id}/comment-threads${separator}${query ? "&" : "?"}status=all`
          : route === "notifications"
            ? `/api/v1/notifications${separator}${query ? "&" : "?"}status=all`
            : `/api/v1/projects/${project.id}/access-logs${separator}`;
    const response = await app.fetch(new Request(`http://localhost${path}`, { headers: { Cookie: cookie } }), localEnv);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      threads?: unknown[];
      notifications?: unknown[];
      logs?: unknown[];
    };
    return (payload.threads ?? payload.notifications ?? payload.logs ?? []).length;
  }

  describe.each([
    { route: "comments" as const, description: "GET /api/v1/projects/:id/comments", note: "fallback は comments.ts の 100" },
    { route: "commentThreads" as const, description: "GET /api/v1/projects/:id/comment-threads", note: "fallback は comments.ts の 50" },
    { route: "notifications" as const, description: "GET /api/v1/notifications", note: "fallback は notifications.ts の 50" },
    { route: "accessLogs" as const, description: "GET /api/v1/projects/:id/access-logs", note: "fallback は projects.ts の 50" }
  ])("$description limit clamp", ({ route, note }) => {
    it.each(limitCases)("keeps current clamp result for $label", async ({ query, expected }) => {
      const localEnv = testEnv();

      const count = await fetchLimitCount(localEnv, route, query);

      // 現行実装は Number(query) || fallback の後に 1..100 へ丸めるため、この件数になる。
      expect({ note, count }).toMatchObject({ count: expected[route] });
    });
  });

  async function seedTimeIdCursorRows(localEnv: Env) {
    const cookie = await authCookie(localEnv);
    const project = await seedProjectWithFile(localEnv, { alias: "cursor-history" });
    await localEnv.DB.batch([
      localEnv.DB.prepare(
        `INSERT INTO comment_threads (
          id, project_id, path, author_user_id, body, anchor_json,
          selected_text, status, created_at, updated_at
        ) VALUES (?, ?, 'index.html', ?, ?, '{}', 'text', 'open', ?, ?)`
      ).bind("thread_cursor_3", project.id, user.id, "latest", "2026-07-01 12:00:00", "2026-07-01 12:00:00"),
      localEnv.DB.prepare(
        `INSERT INTO comment_threads (
          id, project_id, path, author_user_id, body, anchor_json,
          selected_text, status, created_at, updated_at
        ) VALUES (?, ?, 'index.html', ?, ?, '{}', 'text', 'open', ?, ?)`
      ).bind("thread_cursor_2", project.id, user.id, "middle", "2026-07-01 11:00:00", "2026-07-01 11:00:00"),
      localEnv.DB.prepare(
        `INSERT INTO comment_threads (
          id, project_id, path, author_user_id, body, anchor_json,
          selected_text, status, created_at, updated_at
        ) VALUES (?, ?, 'index.html', ?, ?, '{}', 'text', 'open', ?, ?)`
      ).bind("thread_cursor_1", project.id, user.id, "oldest", "2026-07-01 10:00:00", "2026-07-01 10:00:00"),
      localEnv.DB.prepare("INSERT INTO access_logs (id, project_id, user_id, path, accessed_at) VALUES (?, ?, ?, 'index.html', ?)")
        .bind("log_cursor_3", project.id, user.id, "2026-07-01 12:00:00"),
      localEnv.DB.prepare("INSERT INTO access_logs (id, project_id, user_id, path, accessed_at) VALUES (?, ?, ?, 'index.html', ?)")
        .bind("log_cursor_2", project.id, user.id, "2026-07-01 11:00:00"),
      localEnv.DB.prepare("INSERT INTO access_logs (id, project_id, user_id, path, accessed_at) VALUES (?, ?, ?, 'index.html', ?)")
        .bind("log_cursor_1", project.id, user.id, "2026-07-01 10:00:00")
    ]);
    return { cookie, project };
  }

  async function fetchCursorPage(
    localEnv: Env,
    input: { route: "commentThreads" | "accessLogs"; projectId: string; cookie: string; cursorQuery: string }
  ): Promise<{ ids: string[]; nextCursor: string | null }> {
    const path = input.route === "commentThreads"
      ? `/api/v1/projects/${input.projectId}/comment-threads?status=all&limit=1${input.cursorQuery}`
      : `/api/v1/projects/${input.projectId}/access-logs?limit=1${input.cursorQuery}`;
    const response = await app.fetch(new Request(`http://localhost${path}`, { headers: { Cookie: input.cookie } }), localEnv);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      threads?: Array<{ id: string }>;
      logs?: Array<{ id: string }>;
      nextCursor: string | null;
    };
    return {
      ids: (payload.threads ?? payload.logs ?? []).map((item) => item.id),
      nextCursor: payload.nextCursor
    };
  }

  it.each([
    { label: "empty cursor", cursorQuery: "&cursor=", kind: "first-page" },
    { label: "bare separator cursor", cursorQuery: `&cursor=${encodeURIComponent("|")}`, kind: "empty-page" },
    { label: "empty time cursor", cursorQuery: `&cursor=${encodeURIComponent("|abc")}`, kind: "empty-page" },
    { label: "missing separator cursor", cursorQuery: `&cursor=${encodeURIComponent("abc")}`, kind: "throws" },
    { label: "valid future cursor", cursorQuery: `&cursor=${encodeURIComponent("2026-07-02T00:00:00Z|xxxx-yyyy")}`, kind: "first-page" }
  ])("keeps current time-id cursor behavior for $label", async ({ cursorQuery, kind }) => {
    const localEnv = testEnv();
    const { cookie, project } = await seedTimeIdCursorRows(localEnv);

    for (const route of ["commentThreads", "accessLogs"] as const) {
      const request = () => fetchCursorPage(localEnv, { route, projectId: project.id, cookie, cursorQuery });
      if (kind === "throws") {
        await expect(request()).rejects.toThrow();
        continue;
      }
      const page = await request();
      if (kind === "empty-page") {
        expect(page).toMatchObject({ ids: [], nextCursor: null });
      } else {
        expect(page.ids).toEqual(route === "commentThreads" ? ["thread_cursor_3"] : ["log_cursor_3"]);
        expect(page.nextCursor).toBeTruthy();
      }
    }
  });

  function driveJson(value: unknown, status = 200): Response {
    return jsonResponse(value, status);
  }

  function driveText(value: string, status = 200, contentType = "text/html"): Response {
    return new Response(value, { status, headers: { "Content-Type": contentType } });
  }

  function stubDriveFetch(input: {
    scenario: RetryScenario;
    operation: DriveOperation;
    first404?: boolean;
  }) {
    const events: Array<{ kind: "token" | "drive"; method: string; path: string; authorization: string | null; refreshToken?: string }> = [];
    const driveAttempts = new Map<string, number>();
    const fetchMock = vi.fn(async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestInput.toString());
      const method = init?.method ?? "GET";
      if (url.hostname === "oauth.test") {
        const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init?.body ?? ""));
        const refreshToken = body.get("refresh_token") ?? "";
        events.push({ kind: "token", method, path: url.pathname, authorization: null, refreshToken });
        return driveJson({ access_token: `refreshed-${refreshToken}`, token_type: "Bearer", expires_in: 3600 });
      }
      const authorization = init?.headers instanceof Headers
        ? init.headers.get("Authorization")
        : (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      const key = `${method} ${url.pathname}${url.searchParams.get("alt") === "media" ? "?media" : ""}`;
      const attempt = (driveAttempts.get(key) ?? 0) + 1;
      driveAttempts.set(key, attempt);
      events.push({ kind: "drive", method, path: url.pathname, authorization });
      const currentOperation = url.pathname === "/drive/v3/files" && method === "POST"
        ? "folder"
        : url.pathname.startsWith("/upload/drive/v3/files")
          ? "upload"
          : url.pathname.startsWith("/drive/v3/files/") && method === "PATCH"
            ? "trash"
            : url.pathname.startsWith("/drive/v3/files/") && method === "GET" && url.searchParams.get("alt") !== "media"
              ? "download"
              : null;
      const shouldFirst401 = currentOperation === input.operation && input.scenario !== "success" && attempt === 1;
      const shouldSecond401 = currentOperation === input.operation && input.scenario === "refresh-fails" && attempt === 2;
      if (shouldFirst401 || shouldSecond401) {
        return driveText("unauthorized", 401, "text/plain");
      }
      if (input.first404 && attempt === 1) {
        return driveText("missing", 404, "text/plain");
      }
      if (url.pathname === "/drive/v3/files" && method === "POST") {
        return driveJson({ id: "drive_folder_retry", name: "retry-folder", mimeType: "application/vnd.google-apps.folder" });
      }
      if (url.pathname.startsWith("/upload/drive/v3/files")) {
        return driveJson({ id: "drive_file_retry", name: "index.html", size: "18", modifiedTime: "2026-06-20T00:00:00.000Z" });
      }
      if (url.pathname.startsWith("/drive/v3/files/") && method === "PATCH") {
        return driveJson({ id: url.pathname.split("/").pop(), trashed: true });
      }
      if (url.pathname.startsWith("/drive/v3/files/") && method === "GET") {
        if (url.searchParams.get("alt") === "media") {
          return driveText("<h1>Drive</h1>", 200);
        }
        return driveJson({ id: url.pathname.split("/").pop(), name: "index.html", mimeType: "text/html", trashed: false });
      }
      return driveJson({ error: "unexpected_drive_call", path: url.pathname, method }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    return {
      fetchMock,
      events,
      driveEvents: () => events.filter((event) => event.kind === "drive"),
      tokenEvents: () => events.filter((event) => event.kind === "token")
    };
  }

  async function seedRetryUsers(localEnv: Env) {
    await authCookie(localEnv, user);
    await seedUser(localEnv, editorUser, {
      accessToken: "owner-access-token",
      refreshToken: "owner-refresh-token"
    });
  }

  function driveOperationForEvent(event: { method: string; path: string }): DriveOperation | null {
    if (event.path === "/drive/v3/files" && event.method === "POST") {
      return "folder";
    }
    if (event.path.startsWith("/upload/drive/v3/files")) {
      return "upload";
    }
    if (event.path.startsWith("/drive/v3/files/") && event.method === "PATCH") {
      return "trash";
    }
    if (event.path.startsWith("/drive/v3/files/") && event.method === "GET") {
      return "download";
    }
    return null;
  }

  function expectRetryShape(
    recorder: ReturnType<typeof stubDriveFetch>,
    scenario: RetryScenario,
    expected: {
      driveCalls: number;
      tokenRefreshes: number;
      operation: DriveOperation;
      initialAuthorization: string;
      retryAuthorization?: string;
      refreshToken?: string;
    }
  ) {
    expect(recorder.driveEvents()).toHaveLength(expected.driveCalls);
    expect(recorder.tokenEvents()).toHaveLength(expected.tokenRefreshes);
    const targetDriveEvents = recorder.driveEvents().filter((event) => driveOperationForEvent(event) === expected.operation);
    expect(targetDriveEvents[0]?.authorization).toBe(expected.initialAuthorization);
    if (scenario === "refresh-success" || scenario === "refresh-fails") {
      expect(targetDriveEvents[1]?.authorization).toBe(expected.retryAuthorization);
      expect(recorder.tokenEvents()[0]?.refreshToken).toBe(expected.refreshToken);
    }
  }

  async function exerciseDeployFolderCreate(scenario: RetryScenario) {
    const localEnv = testEnv();
    await seedRetryUsers(localEnv);
    const cookie = await createSession(localEnv, user);
    const project = await createProject(localEnv, user, { title: `folder-${scenario}`, alias: `folder-${scenario}`, visibility: "public" });
    const recorder = stubDriveFetch({ scenario, operation: "folder" });

    const response = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/deploy?path=index.html`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "text/html" },
        body: "<h1>Folder</h1>"
      }),
      localEnv
    );

    return { response, recorder };
  }

  async function exerciseUploadRetry(scenario: RetryScenario) {
    const localEnv = testEnv();
    await seedRetryUsers(localEnv);
    const cookie = await createSession(localEnv, user);
    const project = await createProject(localEnv, user, { title: `upload-${scenario}`, alias: `upload-${scenario}`, visibility: "public" });
    await updateProject(localEnv, project.id, { driveFolderId: "drive_folder_existing" });
    const recorder = stubDriveFetch({ scenario, operation: "upload" });

    const response = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/deploy?path=index.html`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "text/html" },
        body: "<h1>Upload</h1>"
      }),
      localEnv
    );

    return { response, recorder };
  }

  async function exerciseStaleTrash(scenario: RetryScenario) {
    const localEnv = testEnv();
    await seedRetryUsers(localEnv);
    const cookie = await createSession(localEnv, user);
    const project = await createProject(localEnv, user, { title: `stale-${scenario}`, alias: `stale-${scenario}`, visibility: "public" });
    await updateProject(localEnv, project.id, { driveFolderId: "drive_folder_existing" });
    await upsertProjectFile(localEnv, {
      projectId: project.id,
      path: "stale.html",
      driveFileId: "drive_file_stale",
      driveOwnerUserId: editorUser.id,
      sizeBytes: 16,
      contentHash: "hash-stale",
      mimeType: "text/html",
      driveModifiedTime: null,
      cacheEtag: null
    });
    const recorder = stubDriveFetch({ scenario, operation: "trash" });
    const zipData = zipSync({ "index.html": new TextEncoder().encode("<h1>Fresh</h1>") });

    const response = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/deploy?name=site.zip`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/zip" },
        body: zipData
      }),
      localEnv
    );

    return { response, recorder };
  }

  async function exerciseFileDelete(scenario: RetryScenario) {
    const localEnv = testEnv();
    await seedRetryUsers(localEnv);
    const cookie = await createSession(localEnv, user);
    const project = await seedProjectWithFile(localEnv, { alias: `file-delete-${scenario}`, driveOwnerUserId: editorUser.id });
    const recorder = stubDriveFetch({ scenario, operation: "trash" });

    const response = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/files?path=index.html`, {
        method: "DELETE",
        headers: { Cookie: cookie }
      }),
      localEnv
    );

    return { response, recorder };
  }

  async function exerciseProjectDelete(scenario: RetryScenario | "first404") {
    const localEnv = testEnv();
    await seedRetryUsers(localEnv);
    const cookie = await createSession(localEnv, user);
    const project = await createProject(localEnv, user, { title: `project-delete-${scenario}`, alias: `project-delete-${scenario}`, visibility: "public" });
    await updateProject(localEnv, project.id, { driveFolderId: "drive_folder_delete" });
    const recorder = stubDriveFetch({
      scenario: scenario === "first404" ? "success" : scenario,
      operation: "trash",
      first404: scenario === "first404"
    });

    const response = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}`, {
        method: "DELETE",
        headers: { Cookie: cookie }
      }),
      localEnv
    );

    return { response, recorder };
  }

  async function exerciseServeFallback(scenario: RetryScenario) {
    const localEnv = testEnv();
    await seedRetryUsers(localEnv);
    await seedProjectWithFile(localEnv, { alias: `serve-${scenario}`, visibility: "public", driveOwnerUserId: editorUser.id });
    const recorder = stubDriveFetch({ scenario, operation: "download" });

    const response = await app.fetch(new Request(`http://localhost/serve-${scenario}/`), localEnv);

    return { response, recorder };
  }

  async function exerciseReviewContent(scenario: RetryScenario) {
    const localEnv = testEnv();
    await seedRetryUsers(localEnv);
    const cookie = await createSession(localEnv, user);
    const project = await seedProjectWithFile(localEnv, { alias: `review-retry-${scenario}`, driveOwnerUserId: editorUser.id });
    const recorder = stubDriveFetch({ scenario, operation: "download" });

    const response = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/review-content?path=index.html`, {
        headers: { Cookie: cookie }
      }),
      localEnv
    );

    return { response, recorder };
  }

  describe.each([
    // current user 経路なので c.get("user").id の access-token / refresh-token を使う。
    { name: "deploy folder create", exercise: exerciseDeployFolderCreate, operation: "folder" as const, successStatus: 200, failureStatus: 502, successDriveCalls: 2, retrySuccessDriveCalls: 3, retryFailureDriveCalls: 2, initialAuthorization: "Bearer access-token", retryAuthorization: "Bearer refreshed-refresh-token", refreshToken: "refresh-token" },
    // current user 経路なので c.get("user").id の access-token / refresh-token を使う。
    { name: "upload retry", exercise: exerciseUploadRetry, operation: "upload" as const, successStatus: 200, failureStatus: 502, successDriveCalls: 1, retrySuccessDriveCalls: 2, retryFailureDriveCalls: 2, initialAuthorization: "Bearer access-token", retryAuthorization: "Bearer refreshed-refresh-token", refreshToken: "refresh-token" },
    // driveOwnerUserId 経路なので file.driveOwnerUserId の owner-access-token / owner-refresh-token を使う。
    { name: "stale trash", exercise: exerciseStaleTrash, operation: "trash" as const, successStatus: 200, failureStatus: 502, successDriveCalls: 2, retrySuccessDriveCalls: 3, retryFailureDriveCalls: 3, initialAuthorization: "Bearer owner-access-token", retryAuthorization: "Bearer refreshed-owner-refresh-token", refreshToken: "owner-refresh-token" },
    // driveOwnerUserId 経路なので file.driveOwnerUserId の owner-access-token / owner-refresh-token を使う。
    { name: "file delete", exercise: exerciseFileDelete, operation: "trash" as const, successStatus: 200, failureStatus: 502, successDriveCalls: 1, retrySuccessDriveCalls: 2, retryFailureDriveCalls: 2, initialAuthorization: "Bearer owner-access-token", retryAuthorization: "Bearer refreshed-owner-refresh-token", refreshToken: "owner-refresh-token" },
    // current user 経路なので project.createdBy の access-token / refresh-token を使う。
    { name: "project delete", exercise: exerciseProjectDelete, operation: "trash" as const, successStatus: 200, failureStatus: 502, successDriveCalls: 1, retrySuccessDriveCalls: 2, retryFailureDriveCalls: 2, initialAuthorization: "Bearer access-token", retryAuthorization: "Bearer refreshed-refresh-token", refreshToken: "refresh-token" },
    // driveOwnerUserId 経路なので file.driveOwnerUserId の owner-access-token / owner-refresh-token を使う。
    { name: "serve fallback", exercise: exerciseServeFallback, operation: "download" as const, successStatus: 200, failureStatus: 502, successDriveCalls: 2, retrySuccessDriveCalls: 3, retryFailureDriveCalls: 2, initialAuthorization: "Bearer owner-access-token", retryAuthorization: "Bearer refreshed-owner-refresh-token", refreshToken: "owner-refresh-token" },
    // driveOwnerUserId 経路なので file.driveOwnerUserId の owner-access-token / owner-refresh-token を使う。
    { name: "review-content download", exercise: exerciseReviewContent, operation: "download" as const, successStatus: 200, failureStatus: 502, successDriveCalls: 2, retrySuccessDriveCalls: 3, retryFailureDriveCalls: 2, initialAuthorization: "Bearer owner-access-token", retryAuthorization: "Bearer refreshed-owner-refresh-token", refreshToken: "owner-refresh-token" }
  ])("$name Drive retry matrix", ({ exercise, operation, successStatus, failureStatus, successDriveCalls, retrySuccessDriveCalls, retryFailureDriveCalls, initialAuthorization, retryAuthorization, refreshToken }) => {
    it("keeps one-shot success behavior", async () => {
      const { response, recorder } = await exercise("success");

      // 一発成功では refresh せず、Drive 呼び出しだけで完了する。
      expect(response.status).toBe(successStatus);
      expectRetryShape(recorder, "success", { driveCalls: successDriveCalls, tokenRefreshes: 0, operation, initialAuthorization });
    });

    it("keeps first 401 then one force refresh success behavior", async () => {
      const { response, recorder } = await exercise("refresh-success");

      // 初回 401 だけ force refresh し、同じ処理を最大 1 回だけ再試行する。
      expect(response.status).toBe(successStatus);
      expectRetryShape(recorder, "refresh-success", { driveCalls: retrySuccessDriveCalls, tokenRefreshes: 1, operation, initialAuthorization, retryAuthorization, refreshToken });
    });

    it("keeps second 401 failure behavior after one force refresh", async () => {
      const { response, recorder } = await exercise("refresh-fails");

      // refresh 後の 401 は追加 retry せず、呼び出し元の現行エラー変換へ進む。
      expect(response.status).toBe(failureStatus);
      expectRetryShape(recorder, "refresh-fails", { driveCalls: retryFailureDriveCalls, tokenRefreshes: 1, operation, initialAuthorization, retryAuthorization, refreshToken });
    });
  });

  it("keeps project delete first 404 as successful deletion", async () => {
    const { response, recorder } = await exerciseProjectDelete("first404");

    // project folder 削除だけは初回 404 を握りつぶして削除成功扱いにする。
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, deleted: true });
    expectRetryShape(recorder, "success", { driveCalls: 1, tokenRefreshes: 0, operation: "trash", initialAuthorization: "Bearer access-token" });
  });

  it("routes /api/v1/projects/:id/comments to commentsRoute before projectsRoute", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await seedProjectWithFile(localEnv, { alias: "route-comments" });

    const response = await app.fetch(new Request(`http://localhost/api/v1/projects/${project.id}/comments?path=index.html`, { headers: { Cookie: cookie } }), localEnv);

    // commentsRoute なら threads 形で返り、projectsRoute の :id JSON 形にはならない。
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ threads: [] });
  });

  it("routes /api/v1/projects/:id/comment-threads to commentsRoute before projectsRoute", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await seedProjectWithFile(localEnv, { alias: "route-threads" });

    const response = await app.fetch(new Request(`http://localhost/api/v1/projects/${project.id}/comment-threads`, { headers: { Cookie: cookie } }), localEnv);

    // commentsRoute なら threads/nextCursor 形で返り、projectsRoute の :id JSON 形にはならない。
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ threads: [], nextCursor: null });
  });

  it("routes /api/v1/projects/:id/review-content to commentsRoute before projectsRoute", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await seedProjectWithFile(localEnv, { alias: "route-review" });
    await localEnv.CACHE_BUCKET.put(`projects/${project.id}/index.html`, "<h1>Route</h1>", {
      httpMetadata: { contentType: "text/html" }
    });

    const response = await app.fetch(new Request(`http://localhost/api/v1/projects/${project.id}/review-content?path=index.html`, { headers: { Cookie: cookie } }), localEnv);

    // commentsRoute なら review-content の html/file 形で返り、projectsRoute の :id JSON 形にはならない。
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ file: { path: "index.html" }, html: "<h1>Route</h1>" });
  });
});
