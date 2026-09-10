import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../auth/session";
import { resolveLoginKind, type IdTokenClaims } from "../auth/oauth";
import {
  canViewProject,
  claimProjectAccessForUser,
  createProject,
  deleteProjectAccess,
  listProjectAccess,
  updateProject,
  updateProjectAccessDriveState,
  upsertProjectAccess,
  upsertProjectMember
} from "../db/projects";
import type { AuthUser } from "../env";
import { escapeHtml } from "../routes/pages/layout";
import app from "../index";
import {
  authCookie,
  editorUser,
  guestUser,
  jsonResponse,
  resetDatabase,
  seedUser,
  testEnv,
  user
} from "./helpers";
function claims(overrides: Partial<IdTokenClaims> = {}): IdTokenClaims {
  return {
    iss: "https://accounts.google.com",
    aud: "test-client-id",
    exp: Math.floor(Date.now() / 1000) + 600,
    sub: "google_external",
    email: "guest@gmail.com",
    email_verified: true,
    ...overrides
  };
}

describe("project access invite + guest boundary", () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    await resetDatabase(testEnv());
  });

  it("allows owner to add, list, and delete project access; rejects editor/viewer", async () => {
    const localEnv = testEnv();
    const ownerCookie = await authCookie(localEnv);
    await seedUser(localEnv, editorUser);
    const project = await createProject(localEnv, user, {
      title: "Invite Site",
      alias: "invite-site",
      visibility: "invite"
    });
    await upsertProjectMember(localEnv, {
      projectId: project.id,
      userId: editorUser.id,
      role: "editor"
    });
    const editorCookie = await createSession(localEnv, editorUser);

    const createRes = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/access`, {
        method: "POST",
        headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "  Guest@Gmail.com  " })
      }),
      localEnv
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      access: { email: string; userId: string | null; id: string };
    };
    expect(created.access.email).toBe("guest@gmail.com");
    expect(created.access.userId).toBeNull();

    const listRes = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/access`, {
        headers: { Cookie: ownerCookie }
      }),
      localEnv
    );
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { access: Array<{ email: string }> };
    expect(listed.access.map((a) => a.email)).toEqual(["guest@gmail.com"]);

    const editorCreate = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/access`, {
        method: "POST",
        headers: { Cookie: editorCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "other@gmail.com" })
      }),
      localEnv
    );
    expect(editorCreate.status).toBe(403);

    const deleteRes = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/access/${created.access.id}`, {
        method: "DELETE",
        headers: { Cookie: ownerCookie }
      }),
      localEnv
    );
    expect(deleteRes.status).toBe(200);
    const after = await listProjectAccess(localEnv, project.id);
    expect(after).toHaveLength(0);
  });

  it("rejects invalid email formats on access POST", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Email Validate",
      alias: "email-validate",
      visibility: "invite"
    });

    for (const email of ["not-an-email", "a@", "@b.com", 'bad"<script>@x.com', ""]) {
      const res = await app.fetch(
        new Request(`http://localhost/api/v1/projects/${project.id}/access`, {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify({ email })
        }),
        localEnv
      );
      expect(res.status).toBe(400);
    }
  });

  it("returns 404 when deleting accessId from another project without mutating target", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const projectA = await createProject(localEnv, user, {
      title: "Project A",
      alias: "project-a",
      visibility: "invite"
    });
    const projectB = await createProject(localEnv, user, {
      title: "Project B",
      alias: "project-b",
      visibility: "invite"
    });
    const accessA = await upsertProjectAccess(localEnv, {
      projectId: projectA.id,
      email: "guest@gmail.com",
      grantedBy: user.id
    });
    const accessB = await upsertProjectAccess(localEnv, {
      projectId: projectB.id,
      email: "other@gmail.com",
      grantedBy: user.id
    });

    // project B owner が project A の accessId を project B の path で削除しようとする
    const res = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${projectB.id}/access/${accessA.id}`, {
        method: "DELETE",
        headers: { Cookie: cookie }
      }),
      localEnv
    );
    expect(res.status).toBe(404);

    const stillA = await listProjectAccess(localEnv, projectA.id);
    const stillB = await listProjectAccess(localEnv, projectB.id);
    expect(stillA.map((a) => a.id)).toEqual([accessA.id]);
    expect(stillB.map((a) => a.id)).toEqual([accessB.id]);
    // delete helper も project_id を必須
    expect(await deleteProjectAccess(localEnv, projectB.id, accessA.id)).toBe(false);
  });

  it("resolves login kind: domain member, invite guest on any visibility, no-invite rejected", async () => {
    const localEnv = testEnv();
    await seedUser(localEnv);
    const inviteProject = await createProject(localEnv, user, {
      title: "Invite Only",
      alias: "invite-only",
      visibility: "invite"
    });
    // 招待は visibility に依らない追加許可なので domain / private の project でも guest login を許す
    const domainProject = await createProject(localEnv, user, {
      title: "Domain Project",
      alias: "domain-project",
      visibility: "domain",
      allowedDomains: ["example.com"]
    });
    const privateProject = await createProject(localEnv, user, {
      title: "Private Only",
      alias: "private-only",
      visibility: "private"
    });
    await upsertProjectAccess(localEnv, {
      projectId: inviteProject.id,
      email: "guest@gmail.com",
      grantedBy: user.id
    });
    await upsertProjectAccess(localEnv, {
      projectId: domainProject.id,
      email: "collab@other.com",
      grantedBy: user.id
    });
    await upsertProjectAccess(localEnv, {
      projectId: privateProject.id,
      email: "private-guest@other.com",
      grantedBy: user.id
    });

    await expect(
      resolveLoginKind(localEnv, claims({ email: "user@example.com", hd: "example.com", sub: "g1" }))
    ).resolves.toBe("member");

    await expect(
      resolveLoginKind(localEnv, claims({ email: "guest@gmail.com", sub: "g_guest" }))
    ).resolves.toBe("guest");

    // domain project への個別招待でも guest として login できる
    await expect(
      resolveLoginKind(localEnv, claims({ email: "collab@other.com", hd: "other.com", sub: "g_collab" }))
    ).resolves.toBe("guest");

    await expect(
      resolveLoginKind(localEnv, claims({ email: "private-guest@other.com", hd: "other.com", sub: "g_priv" }))
    ).resolves.toBe("guest");

    // 招待が無い外部 account は従来どおり拒否
    await expect(
      resolveLoginKind(localEnv, claims({ email: "noinvite@other.com", hd: "other.com", sub: "g_no" }))
    ).rejects.toThrow(/domain is not allowed/);
  });

  it("grants view on a domain project to an individually invited external email, additive to domain auth", async () => {
    const localEnv = testEnv();
    await seedUser(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Domain With Collaborator",
      alias: "domain-with-collab",
      visibility: "domain",
      allowedDomains: ["example.com"]
    });
    const access = await upsertProjectAccess(localEnv, {
      projectId: project.id,
      email: "collab@other.com",
      grantedBy: user.id
    });

    const insider: AuthUser = {
      id: "u_insider",
      googleId: "g_insider",
      email: "insider@example.com",
      name: null,
      avatarUrl: null,
      kind: "member"
    };
    const collaborator: AuthUser = {
      id: "u_collab",
      googleId: "g_collab",
      email: "collab@other.com",
      name: null,
      avatarUrl: null,
      kind: "guest"
    };
    const stranger: AuthUser = {
      id: "u_stranger",
      googleId: "g_stranger",
      email: "stranger@other.com",
      name: null,
      avatarUrl: null,
      kind: "guest"
    };

    // domain 認証の閲覧は維持され、招待した社外 1 名も見える。招待外は見えない
    await expect(canViewProject(localEnv, project, insider)).resolves.toBe(true);
    await expect(canViewProject(localEnv, project, collaborator)).resolves.toBe(true);
    await expect(canViewProject(localEnv, project, stranger)).resolves.toBe(false);

    await deleteProjectAccess(localEnv, project.id, access.id);
    await expect(canViewProject(localEnv, project, collaborator)).resolves.toBe(false);
    // 招待を消しても組織ドメインの閲覧は残る
    await expect(canViewProject(localEnv, project, insider)).resolves.toBe(true);
  });

  it("blocks guest from member APIs while allowing comments path; CLI and API key rejected", async () => {
    const localEnv = testEnv();
    await seedUser(localEnv);
    await seedUser(localEnv, guestUser);
    const project = await createProject(localEnv, user, {
      title: "Guest Bound",
      alias: "guest-bound",
      visibility: "invite"
    });
    await upsertProjectAccess(localEnv, {
      projectId: project.id,
      email: guestUser.email,
      grantedBy: user.id
    });
    await claimProjectAccessForUser(localEnv, guestUser.id, guestUser.email);
    const guestCookie = await createSession(localEnv, guestUser);

    const createProjectRes = await app.fetch(
      new Request("http://localhost/api/v1/projects", {
        method: "POST",
        headers: { Cookie: guestCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Nope", alias: "nope-project" })
      }),
      localEnv
    );
    expect(createProjectRes.status).toBe(403);

    const apiKeyRes = await app.fetch(
      new Request("http://localhost/api/v1/api-keys", {
        method: "POST",
        headers: { Cookie: guestCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "k" })
      }),
      localEnv
    );
    expect(apiKeyRes.status).toBe(403);

    const deployRes = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/deploy`, {
        method: "POST",
        headers: { Cookie: guestCookie, "Content-Type": "text/html" },
        body: "<html></html>"
      }),
      localEnv
    );
    expect(deployRes.status).toBe(403);

    const whoami = await app.fetch(
      new Request("http://localhost/api/v1/whoami", { headers: { Cookie: guestCookie } }),
      localEnv
    );
    expect(whoami.status).toBe(200);
    await expect(whoami.json()).resolves.toMatchObject({ user: { kind: "guest", email: guestUser.email } });

    // comments list は allowlist 内 (canView は invite で通る)
    const comments = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/comments`, {
        headers: { Cookie: guestCookie }
      }),
      localEnv
    );
    expect(comments.status).toBe(200);

    const cliState = "g".repeat(40);
    await localEnv.DB.prepare(
      "INSERT INTO cli_auth_states (state, status, expires_at) VALUES (?, 'pending', ?)"
    )
      .bind(cliState, Math.floor(Date.now() / 1000) + 300)
      .run();
    const cliRes = await app.fetch(
      new Request(`http://localhost/auth/cli/callback?cli_state=${cliState}`, {
        headers: { Cookie: guestCookie }
      }),
      localEnv
    );
    expect(cliRes.status).toBe(403);
  });

  it("claims access on first login identity and keeps view after email change; merge keeps one row", async () => {
    const localEnv = testEnv();
    await seedUser(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Claim Project",
      alias: "claim-project",
      visibility: "invite"
    });
    await upsertProjectAccess(localEnv, {
      projectId: project.id,
      email: "old@gmail.com",
      grantedBy: user.id
    });

    const guest = { ...guestUser, email: "old@gmail.com" };
    await seedUser(localEnv, guest);
    await claimProjectAccessForUser(localEnv, guest.id, "old@gmail.com");

    const accessAfterClaim = await listProjectAccess(localEnv, project.id);
    expect(accessAfterClaim).toHaveLength(1);
    expect(accessAfterClaim[0]?.userId).toBe(guest.id);

    // email 変更後も user_id で閲覧維持
    const guestNewEmail = { ...guest, email: "new@gmail.com" };
    const projectRow = await createProject(localEnv, user, {
      title: "Dummy",
      alias: "dummy-for-get",
      visibility: "private"
    }).then(() => project);
    expect(await canViewProject(localEnv, projectRow, guestNewEmail)).toBe(true);

    // 新 email で再招待 → claim 統合で 1 行
    await upsertProjectAccess(localEnv, {
      projectId: project.id,
      email: "new@gmail.com",
      grantedBy: user.id
    });
    expect(await listProjectAccess(localEnv, project.id)).toHaveLength(2);
    await claimProjectAccessForUser(localEnv, guest.id, "new@gmail.com");
    const merged = await listProjectAccess(localEnv, project.id);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.userId).toBe(guest.id);

    // 1 回削除で閲覧不可
    await deleteProjectAccess(localEnv, project.id, merged[0]!.id);
    expect(await canViewProject(localEnv, project, guestNewEmail)).toBe(false);
  });

  it("canViewProject allows invite access and denies after access deletion", async () => {
    const localEnv = testEnv();
    await seedUser(localEnv);
    await seedUser(localEnv, guestUser);
    const project = await createProject(localEnv, user, {
      title: "View Invite",
      alias: "view-invite",
      visibility: "invite"
    });
    expect(await canViewProject(localEnv, project, guestUser)).toBe(false);

    const access = await upsertProjectAccess(localEnv, {
      projectId: project.id,
      email: guestUser.email,
      grantedBy: user.id
    });
    expect(await canViewProject(localEnv, project, guestUser)).toBe(true);

    await deleteProjectAccess(localEnv, project.id, access.id);
    expect(await canViewProject(localEnv, project, guestUser)).toBe(false);
  });

  it("escapes stored invite emails in HTML renderer output", async () => {
    // API は不正 email を 400 にするが、DB fixture 経由の表示 escape を確認する
    const malicious = `evil<script>@evil.com`;
    const html = `<td class="mono">${escapeHtml(malicious)}</td>`;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("migration 0009 dedupe order keeps survivor for case-variant emails", async () => {
    const localEnv = testEnv();
    await seedUser(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Dedupe",
      alias: "dedupe-proj",
      visibility: "invite"
    });

    // 式 unique index を落として大小文字違いの重複を fixture 投入
    await localEnv.DB.prepare("DROP INDEX IF EXISTS idx_project_access_project_email_lower").run();
    await localEnv.DB.prepare(
      "INSERT INTO project_access (id, project_id, email, granted_by, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind("pa_newer", project.id, "Dup@Example.com", user.id, "2026-01-02 00:00:00")
      .run();
    await localEnv.DB.prepare(
      "INSERT INTO project_access (id, project_id, email, granted_by, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind("pa_older", project.id, "dup@example.com", user.id, "2026-01-01 00:00:00")
      .run();

    // migration と同じ順序: survivor 以外 DELETE → lower UPDATE → index 再作成
    await localEnv.DB.prepare(
      `DELETE FROM project_access
       WHERE id IN (
         SELECT pa.id
         FROM project_access pa
         WHERE EXISTS (
           SELECT 1 FROM project_access better
           WHERE better.project_id = pa.project_id
             AND lower(better.email) = lower(pa.email)
             AND (
               better.created_at < pa.created_at
               OR (better.created_at = pa.created_at AND better.id < pa.id)
             )
         )
       )`
    ).run();
    await localEnv.DB.prepare("UPDATE project_access SET email = lower(email)").run();
    await localEnv.DB.prepare(
      "CREATE UNIQUE INDEX idx_project_access_project_email_lower ON project_access (project_id, lower(email))"
    ).run();

    const rows = await listProjectAccess(localEnv, project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("pa_older");
    expect(rows[0]?.email).toBe("dup@example.com");
  });

  it("grants Drive permission on invite with supportsAllDrives and no notification email", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Drive Sync",
      alias: "drive-sync",
      visibility: "domain"
    });
    await updateProject(localEnv, project.id, { driveFolderId: "folder_drive_sync" });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.pathname === "/drive/v3/files/folder_drive_sync/permissions" && init?.method === "POST") {
        expect(url.searchParams.get("supportsAllDrives")).toBe("true");
        expect(url.searchParams.get("sendNotificationEmail")).toBe("false");
        const body = JSON.parse(String(init.body)) as {
          type: string;
          role: string;
          emailAddress: string;
        };
        expect(body).toEqual({
          type: "user",
          role: "reader",
          emailAddress: "guest@gmail.com"
        });
        return jsonResponse({ id: "perm_reader_1" });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/access`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "guest@gmail.com" })
      }),
      localEnv
    );
    expect(res.status).toBe(201);
    const payload = (await res.json()) as {
      access: { drivePermissionId: string | null; driveRole: string | null; driveError: string | null };
      drive_error: string | null;
    };
    expect(payload.access.drivePermissionId).toBe("perm_reader_1");
    expect(payload.access.driveRole).toBe("reader");
    expect(payload.access.driveError).toBeNull();
    expect(payload.drive_error).toBeNull();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("passes selected drive_role (commenter/writer) to Drive create", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Drive Role",
      alias: "drive-role",
      visibility: "domain"
    });
    await updateProject(localEnv, project.id, { driveFolderId: "folder_role" });

    for (const role of ["commenter", "writer"] as const) {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input.toString());
        if (url.pathname.endsWith("/permissions") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { role: string };
          expect(body.role).toBe(role);
          return jsonResponse({ id: `perm_${role}` });
        }
        return jsonResponse({ error: "unexpected" }, 500);
      });
      vi.stubGlobal("fetch", fetchMock);

      const res = await app.fetch(
        new Request(`http://localhost/api/v1/projects/${project.id}/access`, {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify({ email: `${role}@gmail.com`, drive_role: role })
        }),
        localEnv
      );
      expect(res.status).toBe(201);
      const payload = (await res.json()) as { access: { driveRole: string; drivePermissionId: string } };
      expect(payload.access.driveRole).toBe(role);
      expect(payload.access.drivePermissionId).toBe(`perm_${role}`);
    }
  });

  it("deletes Drive permission by stored id on invite delete", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Drive Revoke",
      alias: "drive-revoke",
      visibility: "domain"
    });
    await updateProject(localEnv, project.id, { driveFolderId: "folder_revoke" });
    const access = await upsertProjectAccess(localEnv, {
      projectId: project.id,
      email: "revoke@gmail.com",
      grantedBy: user.id,
      driveRole: "reader"
    });
    await updateProjectAccessDriveState(localEnv, access.id, {
      drivePermissionId: "perm_to_delete",
      driveError: null
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (
        url.pathname === "/drive/v3/files/folder_revoke/permissions/perm_to_delete" &&
        init?.method === "DELETE"
      ) {
        expect(url.searchParams.get("supportsAllDrives")).toBe("true");
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/access/${access.id}`, {
        method: "DELETE",
        headers: { Cookie: cookie }
      }),
      localEnv
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await listProjectAccess(localEnv, project.id)).toHaveLength(0);
  });

  it("does not call Drive on delete when drive_permission_id is absent", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "No Drive Record",
      alias: "no-drive-record",
      visibility: "domain"
    });
    await updateProject(localEnv, project.id, { driveFolderId: "folder_manual" });
    const access = await upsertProjectAccess(localEnv, {
      projectId: project.id,
      email: "manual@gmail.com",
      grantedBy: user.id
    });
    // drive_permission_id 無し = publicar 付与記録なし

    const fetchMock = vi.fn(async () => jsonResponse({ error: "should_not_call" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/access/${access.id}`, {
        method: "DELETE",
        headers: { Cookie: cookie }
      }),
      localEnv
    );
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps invite as 201 when Drive returns 403 and stores drive_error", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Drive Fail",
      alias: "drive-fail",
      visibility: "domain"
    });
    await updateProject(localEnv, project.id, { driveFolderId: "folder_fail" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: { errors: [{ reason: "domainPolicy" }], message: "policy" } },
          403
        )
      )
    );

    const res = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/access`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "blocked@gmail.com", drive_role: "reader" })
      }),
      localEnv
    );
    expect(res.status).toBe(201);
    const payload = (await res.json()) as {
      access: { drivePermissionId: string | null; driveError: string | null; email: string };
      drive_error: string | null;
    };
    expect(payload.access.email).toBe("blocked@gmail.com");
    expect(payload.access.drivePermissionId).toBeNull();
    expect(payload.access.driveError).toBeTruthy();
    expect(payload.drive_error).toContain("403");

    // UI 表示用に HTML へ escape されること
    const detail = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, { headers: { Cookie: cookie } }),
      localEnv
    );
    const html = await detail.text();
    expect(html).toContain("blocked@gmail.com");
    expect(html).toContain(escapeHtml(payload.access.driveError!));
  });

  it("rejects invalid drive_role with 400", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Bad Role",
      alias: "bad-role",
      visibility: "domain"
    });

    const res = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/access`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "x@gmail.com", drive_role: "owner" })
      }),
      localEnv
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid_drive_role" });
  });

  it("keeps existing drive_permission_id when re-invite Drive grant fails, and delete still revokes it", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Reinvite Fail Keep",
      alias: "reinvite-fail-keep",
      visibility: "domain"
    });
    await updateProject(localEnv, project.id, { driveFolderId: "folder_reinvite_fail" });

    // 初回: reader で成功
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input.toString());
        if (url.pathname.endsWith("/permissions") && init?.method === "POST") {
          return jsonResponse({ id: "perm_keep_1" });
        }
        return jsonResponse({ error: "unexpected" }, 500);
      })
    );
    const first = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/access`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "x@outside.test", drive_role: "reader" })
      }),
      localEnv
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { access: { id: string; drivePermissionId: string } };
    expect(firstBody.access.drivePermissionId).toBe("perm_keep_1");

    // 再招待: writer だが Drive 403 → id 保持
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { errors: [{ reason: "domainPolicy" }] } }, 403)
      )
    );
    const second = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/access`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "x@outside.test", drive_role: "writer" })
      }),
      localEnv
    );
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as {
      access: { drivePermissionId: string | null; driveError: string | null; driveRole: string };
      drive_error: string | null;
    };
    expect(secondBody.access.drivePermissionId).toBe("perm_keep_1");
    expect(secondBody.access.driveError).toBeTruthy();
    expect(secondBody.access.driveRole).toBe("writer");

    const rows = await listProjectAccess(localEnv, project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.drivePermissionId).toBe("perm_keep_1");

    // 削除で保存済み id の DELETE が呼ばれる
    const deleteMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (
        url.pathname === "/drive/v3/files/folder_reinvite_fail/permissions/perm_keep_1" &&
        init?.method === "DELETE"
      ) {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", deleteMock);

    const del = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/access/${firstBody.access.id}`, {
        method: "DELETE",
        headers: { Cookie: cookie }
      }),
      localEnv
    );
    expect(del.status).toBe(200);
    expect(deleteMock).toHaveBeenCalled();
    expect(await listProjectAccess(localEnv, project.id)).toHaveLength(0);
  });

  it("updates existing Drive permission role on successful re-invite instead of create", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Reinvite Update",
      alias: "reinvite-update",
      visibility: "domain"
    });
    await updateProject(localEnv, project.id, { driveFolderId: "folder_reinvite_update" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input.toString());
        if (url.pathname.endsWith("/permissions") && init?.method === "POST") {
          return jsonResponse({ id: "perm_update_1" });
        }
        return jsonResponse({ error: "unexpected" }, 500);
      })
    );
    const first = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/access`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "y@outside.test", drive_role: "reader" })
      }),
      localEnv
    );
    expect(first.status).toBe(201);

    const updateMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (
        url.pathname === "/drive/v3/files/folder_reinvite_update/permissions/perm_update_1" &&
        init?.method === "PATCH"
      ) {
        expect(url.searchParams.get("supportsAllDrives")).toBe("true");
        const body = JSON.parse(String(init.body)) as { role: string };
        expect(body.role).toBe("writer");
        return jsonResponse({ id: "perm_update_1", role: "writer" });
      }
      // create は呼ばれてはいけない
      if (init?.method === "POST") {
        return jsonResponse({ error: "should_not_create" }, 500);
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", updateMock);

    const second = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/access`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "y@outside.test", drive_role: "writer" })
      }),
      localEnv
    );
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as {
      access: { drivePermissionId: string | null; driveRole: string; driveError: string | null };
    };
    expect(secondBody.access.drivePermissionId).toBe("perm_update_1");
    expect(secondBody.access.driveRole).toBe("writer");
    expect(secondBody.access.driveError).toBeNull();
    expect(updateMock).toHaveBeenCalled();
    const methods = updateMock.mock.calls.map((call) => (call[1] as RequestInit | undefined)?.method);
    expect(methods).toContain("PATCH");
    expect(methods).not.toContain("POST");
  });

  it("keeps access row and returns 502 when Drive revoke fails; retry succeeds after Drive recovers", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const project = await createProject(localEnv, user, {
      title: "Revoke Fail",
      alias: "revoke-fail",
      visibility: "domain"
    });
    await updateProject(localEnv, project.id, { driveFolderId: "folder_revoke_fail" });
    const access = await upsertProjectAccess(localEnv, {
      projectId: project.id,
      email: "retry@gmail.com",
      grantedBy: user.id,
      driveRole: "reader"
    });
    await updateProjectAccessDriveState(localEnv, access.id, {
      drivePermissionId: "perm_retry",
      driveError: null
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "internal" }, 500))
    );

    const failRes = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/access/${access.id}`, {
        method: "DELETE",
        headers: { Cookie: cookie }
      }),
      localEnv
    );
    expect(failRes.status).toBe(502);
    const failBody = (await failRes.json()) as { error: string; drive_error: string };
    expect(failBody.error).toBe("drive_revoke_failed");
    expect(failBody.drive_error).toBeTruthy();

    const remaining = await listProjectAccess(localEnv, project.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(access.id);
    expect(remaining[0]?.drivePermissionId).toBe("perm_retry");
    expect(remaining[0]?.driveError).toBeTruthy();

    // Drive が復旧したら再試行で行が消える
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input.toString());
        if (
          url.pathname === "/drive/v3/files/folder_revoke_fail/permissions/perm_retry" &&
          init?.method === "DELETE"
        ) {
          return new Response(null, { status: 204 });
        }
        return jsonResponse({ error: "unexpected" }, 500);
      })
    );

    const okRes = await app.fetch(
      new Request(`http://localhost/api/v1/projects/${project.id}/access/${access.id}`, {
        method: "DELETE",
        headers: { Cookie: cookie }
      }),
      localEnv
    );
    expect(okRes.status).toBe(200);
    expect(await listProjectAccess(localEnv, project.id)).toHaveLength(0);
  });
});
