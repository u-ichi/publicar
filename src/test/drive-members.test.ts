import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProject, getProjectRole } from "../db/projects";
import app from "../index";
import { syncDriveMembers } from "../storage/drive-members";
import { createSession } from "../auth/session";
import { editorUser, jsonResponse, resetDatabase, seedUser, user } from "./helpers";
import { serviceEnv } from "./service-account-helpers";

// 共有ドライブ: user@example.com を個人で、team@example.com を Google グループで、partner.example をドメインで共有する。
// team の中に editor-group@example.com（入れ子のグループ）があり、その中に editor@example.com がいる
function mockGoogle(options: { drivePermissions?: unknown[]; failDrive?: number; groupUnauthorizedOnce?: boolean } = {}) {
  let groupCalls = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input.toString());
    if (url.href === "https://oauth2.googleapis.com/token") return jsonResponse({ access_token: "service-access-token", token_type: "Bearer", expires_in: 3600 });
    if (url.pathname === "/drive/v3/files/drive_team/permissions") {
      if (options.failDrive) return jsonResponse({ error: "failed" }, options.failDrive);
      return jsonResponse({ permissions: options.drivePermissions ?? [
        { type: "user", emailAddress: "User@example.com" },
        { type: "group", emailAddress: "team@example.com" },
        { type: "domain", domain: "partner.example" }
      ] });
    }
    if (url.hostname === "cloudidentity.googleapis.com" && url.pathname === "/v1/groups:lookup") {
      return jsonResponse({ name: url.searchParams.get("groupKey.id") === "team@example.com" ? "groups/team" : "groups/editors" });
    }
    if (url.pathname === "/v1/groups/team/memberships" && options.groupUnauthorizedOnce && groupCalls++ === 0) return jsonResponse({ error: "expired" }, 401);
    if (url.pathname === "/v1/groups/team/memberships") return jsonResponse({ memberships: [{ type: "GROUP", preferredMemberKey: { id: "editor-group@example.com" } }] });
    if (url.pathname === "/v1/groups/editors/memberships") return jsonResponse({ memberships: [{ type: "USER", preferredMemberKey: { id: "editor@example.com" } }] });
    return jsonResponse({ error: "unexpected" }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("drive member sync", () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    const env = await serviceEnv();
    await resetDatabase(env);
    await seedUser(env);
  });

  it("decides project access by shared drive members, expanding nested Google groups and domains", async () => {
    const env = await serviceEnv();
    const outsider = { ...editorUser, id: "user_out", googleId: "google_out", email: "outsider@example.com" };
    await seedUser(env, editorUser);
    await seedUser(env, outsider);
    const project = await createProject(env, user, { title: "Doc", alias: "doc-site", visibility: "domain" });
    // 取り込み前は組織の利用者全員が所有者として扱われる
    expect(await getProjectRole(env, project.id, outsider.id)).toBe("owner");

    mockGoogle();
    await syncDriveMembers(env);

    expect(await getProjectRole(env, project.id, user.id)).toBe("owner");
    expect(await getProjectRole(env, project.id, editorUser.id)).toBe("owner");
    expect(await getProjectRole(env, project.id, outsider.id)).toBeNull();
    const sync = await env.DB.prepare("SELECT source, member_count, domain_count, group_count, last_error FROM drive_member_sync").first();
    expect(sync).toEqual({ source: "shared_drive", member_count: 2, domain_count: 1, group_count: 1, last_error: null });

    const status = await app.fetch(new Request("http://localhost/api/v1/drive-members/status", { headers: { Cookie: await createSession(env, outsider) } }), env);
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ rule: "drive_members", self_included: false });

    // 一覧にいない人はプロジェクトを作れず、行も残らない
    const outsiderCookie = await createSession(env, outsider);
    const created = await app.fetch(new Request("http://localhost/api/v1/projects", {
      method: "POST", headers: { Cookie: outsiderCookie, "Content-Type": "application/json" }, body: JSON.stringify({ title: "Mine", alias: "outsider-site" })
    }), env);
    expect(created.status).toBe(403);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM projects WHERE alias = 'outsider-site'").first()).toEqual({ n: 0 });

    // 一覧から外れた人には、見られなくなったプロジェクトのコメント通知を返さない
    await env.DB.prepare("INSERT INTO comment_threads (id, project_id, path, author_user_id, body) VALUES ('thr_1', ?, 'index.html', ?, 'secret body')").bind(project.id, user.id).run();
    await env.DB.prepare("INSERT INTO notification_events (id, project_id, thread_id, actor_user_id, kind, title, body, url) VALUES ('nevt_1', ?, 'thr_1', ?, 'comment_created', 'Doc', 'secret body', '/x')").bind(project.id, user.id).run();
    await env.DB.prepare("INSERT INTO notification_deliveries (id, event_id, recipient_user_id, channel, status, delivered_at) VALUES ('ndlv_1', 'nevt_1', ?, 'app', 'delivered', datetime('now'))").bind(outsider.id).run();
    const notifications = await app.fetch(new Request("http://localhost/api/v1/notifications?status=all", { headers: { Cookie: outsiderCookie } }), env);
    await expect(notifications.json()).resolves.toMatchObject({ notifications: [], unreadCount: 0 });
  });

  it("re-expands Google groups from scratch when a group request is retried after 401", async () => {
    const env = await serviceEnv();
    await seedUser(env, editorUser);
    const project = await createProject(env, user, { title: "Doc", alias: "doc-site", visibility: "domain" });
    mockGoogle({ groupUnauthorizedOnce: true });
    await syncDriveMembers(env);
    expect(await getProjectRole(env, project.id, editorUser.id)).toBe("owner");
    expect(await env.DB.prepare("SELECT member_count, last_error FROM drive_member_sync").first()).toEqual({ member_count: 2, last_error: null });
  });

  it("keeps the previous member list when a sync fails or returns no members", async () => {
    const env = await serviceEnv();
    const project = await createProject(env, user, { title: "Doc", alias: "doc-site", visibility: "domain" });
    mockGoogle();
    await syncDriveMembers(env);

    mockGoogle({ failDrive: 500 });
    await syncDriveMembers(env);
    expect(await getProjectRole(env, project.id, user.id)).toBe("owner");
    expect((await env.DB.prepare("SELECT last_error FROM drive_member_sync").first<{ last_error: string }>())?.last_error).toContain("500");

    mockGoogle({ drivePermissions: [] });
    await syncDriveMembers(env);
    expect(await getProjectRole(env, project.id, user.id)).toBe("owner");
    expect((await env.DB.prepare("SELECT last_error FROM drive_member_sync").first<{ last_error: string }>())?.last_error).toBe("drive_members_empty");
  });
});
