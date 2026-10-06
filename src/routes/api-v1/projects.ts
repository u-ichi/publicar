import { Hono } from "hono";
import { listAccessLogs } from "../../db/access-logs";
import {
  canOwnProject,
  countProjectOwners,
  createProject,
  deleteProject,
  deleteProjectAccess,
  deleteProjectMember,
  getProjectAccess,
  getProjectById,
  getProjectForUser,
  getProjectRole,
  isDriveAccessRole,
  isProjectVisibility,
  isValidAlias,
  isValidInviteEmail,
  listProjectsForUser,
  listProjectAccess,
  listProjectMembers,
  normalizeFilePath,
  updateProject,
  updateProjectAccessDriveState,
  updateProjectMemberRole,
  upsertProjectAccess,
  upsertProjectMember,
  type ProjectRole
} from "../../db/projects";
import { getUserByEmail } from "../../db/users";
import type { AppBindings } from "../../env";
import { withDriveAuthRetry, withProjectDriveAuth } from "../../lib/drive-retry";
import { getProjectStorage } from "../../storage/service-account-drive";
import { removeServiceAccountFile, removeServiceAccountProject } from "../../db/storage-mutations";
import { beginLegacyStorageOperation, assertLegacyStorageOperation, finishLegacyStorageOperation } from "../../db/storage-transition";
import { jsonArray, projectUrl } from "../../lib/http";
import { clampRequestLimit, nullableStringValue, readJsonObject, stringValue } from "../../lib/request";
import { deleteCachedFile, deleteCachedPrefix } from "../../storage/r2";
import { deleteProjectFile, getProjectFile, listProjectFilesWithDeployers, r2KeyForProjectFile } from "../../db/project-files";
import {
  createDrivePermission,
  deleteDrivePermission,
  trashDriveFile,
  updateDrivePermission
} from "../../storage/drive";
import { driveDeleteFailureResponse } from "./drive-errors";
import { requireOwner } from "./guards";

/** Drive 失敗理由を UI / API 向けの短文にする */
function driveErrorMessage(error: unknown, action: "grant" | "revoke"): string {
  const fallback =
    action === "grant" ? "Drive 権限の付与に失敗しました" : "Drive 権限の取り消しに失敗しました";
  if (!(error instanceof Error)) {
    return fallback;
  }
  const message = error.message;
  const statusMatch = message.match(/failed with (\d+)/);
  const status = statusMatch?.[1];
  let reason = "";
  if (message.includes("domainPolicy")) {
    reason = "domainPolicy (組織の外部共有ポリシー)";
  } else if (message.includes("sharingRateLimitExceeded")) {
    reason = "sharingRateLimitExceeded (共有レート制限)";
  } else if (message.includes("invalidSharingRequest")) {
    reason = "invalidSharingRequest";
  } else if (message.includes("cannotModifyInheritedTeamDrivePermission")) {
    reason = "cannotModifyInheritedTeamDrivePermission";
  }
  if (status && reason) {
    return `${fallback} (HTTP ${status}: ${reason})`;
  }
  if (status) {
    return `${fallback} (HTTP ${status})`;
  }
  return `${fallback}: ${message.slice(0, 120)}`;
}

export const projectsRoute = new Hono<AppBindings>();

function parseDomains(value: unknown): string[] | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  const values = jsonArray(value);
  if (!values) {
    return null;
  }
  return values.map((item) => item.toLowerCase().trim()).filter(Boolean);
}

function isProjectRole(value: unknown): value is ProjectRole {
  return value === "owner" || value === "editor" || value === "viewer";
}

projectsRoute.get("/", async (c) => {
  return c.json({ projects: await listProjectsForUser(c.env, c.get("user").id) });
});

projectsRoute.post("/", async (c) => {
  const body = await readJsonObject(c.req.raw);
  if (!body) {
    return c.json({ error: "invalid_json" }, 400);
  }
  const title = stringValue(body.title)?.trim();
  const alias = stringValue(body.alias)?.trim();
  const description = nullableStringValue(body.description);
  const allowedDomains = parseDomains(body.allowed_domains);
  const allowedGroups = parseDomains(body.allowed_groups);
  const entryPath = stringValue(body.entry_path);
  const visibility = body.visibility === undefined ? undefined : body.visibility;

  if (!title || (alias !== undefined && !isValidAlias(alias))) {
    return c.json({ error: "invalid_project" }, 400);
  }
  if (visibility !== undefined && !isProjectVisibility(visibility)) {
    return c.json({ error: "invalid_visibility" }, 400);
  }
  if (allowedDomains === null || allowedGroups === null) {
    return c.json({ error: "invalid_access_list" }, 400);
  }
  if (entryPath !== undefined && !normalizeFilePath(entryPath)) {
    return c.json({ error: "invalid_entry_path" }, 400);
  }

  try {
    const project = await createProject(c.env, c.get("user"), {
      title,
      alias,
      description,
      visibility,
      allowedDomains,
      allowedGroups,
      entryPath
    });
    return c.json({ ok: true, project, url: projectUrl(c.req.raw, project.alias) }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE")) {
      return c.json({ error: "alias_conflict" }, 409);
    }
    return c.json({ error: "project_create_failed" }, 400);
  }
});

projectsRoute.get("/:id", async (c) => {
  const project = await getProjectForUser(c.env, c.req.param("id"), c.get("user").id);
  if (!project) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({ project, url: projectUrl(c.req.raw, project.alias) });
});

projectsRoute.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const ownerError = await requireOwner(c, id);
  if (ownerError) {
    return ownerError;
  }
  const body = await readJsonObject(c.req.raw);
  if (!body) {
    return c.json({ error: "invalid_json" }, 400);
  }
  const title = stringValue(body.title)?.trim();
  const alias = stringValue(body.alias)?.trim();
  const description = nullableStringValue(body.description);
  const visibility = body.visibility === undefined ? undefined : body.visibility;
  const allowedDomains = parseDomains(body.allowed_domains);
  const allowedGroups = parseDomains(body.allowed_groups);
  const entryPath = stringValue(body.entry_path);

  if (body.title !== undefined && !title) {
    return c.json({ error: "invalid_project" }, 400);
  }
  if (body.alias !== undefined && (!alias || !isValidAlias(alias))) {
    return c.json({ error: "invalid_project" }, 400);
  }
  if (visibility !== undefined && !isProjectVisibility(visibility)) {
    return c.json({ error: "invalid_visibility" }, 400);
  }
  if (allowedDomains === null || allowedGroups === null) {
    return c.json({ error: "invalid_access_list" }, 400);
  }
  if (entryPath !== undefined && !normalizeFilePath(entryPath)) {
    return c.json({ error: "invalid_entry_path" }, 400);
  }

  try {
    const project = await updateProject(c.env, id, {
      alias,
      title,
      description,
      visibility,
      allowedDomains,
      allowedGroups,
      entryPath
    });
    if (!project) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({ ok: true, project, url: projectUrl(c.req.raw, project.alias) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE")) {
      return c.json({ error: "alias_conflict" }, 409);
    }
    return c.json({ error: "project_update_failed" }, 400);
  }
});

projectsRoute.get("/:id/files", async (c) => {
  const id = c.req.param("id");
  const role = await getProjectRole(c.env, id, c.get("user").id);
  if (!role) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({ files: await listProjectFilesWithDeployers(c.env, id) });
});

projectsRoute.delete("/:id/files", async (c) => {
  const id = c.req.param("id");
  const path = normalizeFilePath(c.req.query("path") ?? "");
  if (!path) {
    return c.json({ error: "invalid_path" }, 400);
  }
  const role = await getProjectRole(c.env, id, c.get("user").id);
  if (!role) {
    return c.json({ error: "not_found" }, 404);
  }
  if (role === "viewer") {
    return c.json({ error: "forbidden" }, 403);
  }
  const file = await getProjectFile(c.env, id, path);
  if (!file) {
    await deleteCachedFile(c.env, r2KeyForProjectFile(id, path));
    return c.json({ ok: true, deleted: false });
  }
  const ownerUserId = file.driveOwnerUserId ?? c.get("user").id;
  if ((await getProjectStorage(c.env, id))?.storage_service_account) {
    try {
      return c.json({ ok: true, deleted: await removeServiceAccountFile(c.env, id, path, c.get("user").id) });
    } catch { return c.json({ error: "deployment_conflict" }, 409); }
  }
  const operation = await beginLegacyStorageOperation(c.env, id);
  if (!operation) return c.json({ error: "project_storage_changed" }, 409);
  try {
    try {
      if (file.driveFileId) {
        const driveFileId = file.driveFileId;
        await withDriveAuthRetry(c.env, ownerUserId, async (accessToken) => {
          await assertLegacyStorageOperation(c.env, operation);
          return trashDriveFile(c.env, accessToken, driveFileId);
        });
      }
    } catch (error) {
      const response = driveDeleteFailureResponse(c, error);
      if (response) {
        return response;
      }
      throw error;
    }
    await assertLegacyStorageOperation(c.env, operation);
    await deleteCachedFile(c.env, file.r2Key);
    await assertLegacyStorageOperation(c.env, operation);
    await deleteProjectFile(c.env, id, path);
    return c.json({ ok: true, deleted: true });
  } finally { await finishLegacyStorageOperation(c.env, operation); }
});

projectsRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const project = await getProjectForUser(c.env, id, c.get("user").id);
  const role = project?.role ?? null;
  if (!project || !canOwnProject(role)) {
    return c.json({ error: role ? "forbidden" : "not_found" }, role ? 403 : 404);
  }
  if ((await getProjectStorage(c.env, id))?.storage_service_account) {
    try {
      await removeServiceAccountProject(c.env, id, c.get("user").id);
      return c.json({ ok: true, deleted: true });
    } catch { return c.json({ error: "project_storage_changed" }, 409); }
  }
  const operation = await beginLegacyStorageOperation(c.env, id);
  if (!operation) return c.json({ error: "project_storage_changed" }, 409);
  try {
    if (project.driveFolderId) {
      const driveFolderId = project.driveFolderId;
      try {
        await withDriveAuthRetry(c.env, project.createdBy, async (accessToken) => {
          await assertLegacyStorageOperation(c.env, operation);
          await trashDriveFile(c.env, accessToken, driveFolderId);
        }, { ignoreTrash404OnFirstAttempt: true });
      } catch (error) {
        const response = driveDeleteFailureResponse(c, error);
        if (response) {
          return response;
        }
        throw error;
      }
    }
    await assertLegacyStorageOperation(c.env, operation);
    await deleteCachedPrefix(c.env, `projects/${id}/`);
    await assertLegacyStorageOperation(c.env, operation);
    await deleteProject(c.env, id);
    return c.json({ ok: true, deleted: true });
  } finally { await finishLegacyStorageOperation(c.env, operation); }
});

projectsRoute.get("/:id/members", async (c) => {
  const id = c.req.param("id");
  const role = await getProjectRole(c.env, id, c.get("user").id);
  if (!role) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({ members: await listProjectMembers(c.env, id) });
});

projectsRoute.post("/:id/members", async (c) => {
  const id = c.req.param("id");
  const ownerError = await requireOwner(c, id);
  if (ownerError) {
    return ownerError;
  }
  const body = await readJsonObject(c.req.raw);
  if (!body) {
    return c.json({ error: "invalid_json" }, 400);
  }
  const email = stringValue(body.email)?.trim();
  const role = body.role ?? "viewer";
  if (!email || !isProjectRole(role)) {
    return c.json({ error: "invalid_member" }, 400);
  }
  const targetUser = await getUserByEmail(c.env, email);
  if (!targetUser) {
    return c.json({ error: "user_not_found" }, 404);
  }
  const member = await upsertProjectMember(c.env, {
    projectId: id,
    userId: targetUser.id,
    role
  });
  return c.json({ ok: true, member }, 201);
});

projectsRoute.patch("/:id/members/:userId", async (c) => {
  const id = c.req.param("id");
  const userId = c.req.param("userId");
  const ownerError = await requireOwner(c, id);
  if (ownerError) {
    return ownerError;
  }
  const body = await readJsonObject(c.req.raw);
  if (!body || !isProjectRole(body.role)) {
    return c.json({ error: "invalid_member" }, 400);
  }
  const currentRole = await getProjectRole(c.env, id, userId);
  if (currentRole === "owner" && body.role !== "owner" && (await countProjectOwners(c.env, id)) <= 1) {
    return c.json({ error: "last_owner_required" }, 409);
  }
  const member = await updateProjectMemberRole(c.env, id, userId, body.role);
  if (!member) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({ ok: true, member });
});

projectsRoute.delete("/:id/members/:userId", async (c) => {
  const id = c.req.param("id");
  const userId = c.req.param("userId");
  const ownerError = await requireOwner(c, id);
  if (ownerError) {
    return ownerError;
  }
  const currentRole = await getProjectRole(c.env, id, userId);
  if (currentRole === "owner" && (await countProjectOwners(c.env, id)) <= 1) {
    return c.json({ error: "last_owner_required" }, 409);
  }
  const deleted = await deleteProjectMember(c.env, id, userId);
  if (!deleted) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({ ok: true });
});

projectsRoute.get("/:id/access", async (c) => {
  const id = c.req.param("id");
  const ownerError = await requireOwner(c, id);
  if (ownerError) {
    return ownerError;
  }
  return c.json({ access: await listProjectAccess(c.env, id) });
});

projectsRoute.post("/:id/access", async (c) => {
  const id = c.req.param("id");
  const ownerError = await requireOwner(c, id);
  if (ownerError) {
    return ownerError;
  }
  const body = await readJsonObject(c.req.raw);
  if (!body) {
    return c.json({ error: "invalid_json" }, 400);
  }
  const email = stringValue(body.email)?.trim().toLowerCase();
  if (!email || !isValidInviteEmail(email)) {
    return c.json({ error: "invalid_email" }, 400);
  }
  const driveRoleRaw = body.drive_role === undefined ? "reader" : body.drive_role;
  if (!isDriveAccessRole(driveRoleRaw)) {
    return c.json({ error: "invalid_drive_role" }, 400);
  }
  try {
    let access = await upsertProjectAccess(c.env, {
      projectId: id,
      email,
      grantedBy: c.get("user").id,
      driveRole: driveRoleRaw
    });
    const project = await getProjectById(c.env, id);
    let driveError: string | null = null;
    // upsert 後も保持されている既存 id (再招待で失敗しても孤児化させない)
    const previousPermissionId = access.drivePermissionId;
    if (!project?.driveFolderId) {
      driveError = "Drive フォルダ未作成のため未反映";
      await updateProjectAccessDriveState(c.env, access.id, {
        drivePermissionId: previousPermissionId,
        driveError
      });
    } else {
      try {
        const permissionId = await withProjectDriveAuth(c.env, project.id, project.createdBy, async (accessToken) => {
          // 既存 permission がある再招待は create せず role 更新 (孤児化・重複防止)
          if (previousPermissionId) {
            await updateDrivePermission(
              c.env,
              accessToken,
              project.driveFolderId!,
              previousPermissionId,
              driveRoleRaw
            );
            return previousPermissionId;
          }
          return createDrivePermission(c.env, accessToken, project.driveFolderId!, {
            email,
            role: driveRoleRaw
          });
        });
        await updateProjectAccessDriveState(c.env, access.id, {
          drivePermissionId: permissionId,
          driveError: null
        });
      } catch (error) {
        // publicar の招待は成立させる。Drive 失敗時も既存 permission id は維持する
        driveError = driveErrorMessage(error, "grant");
        await updateProjectAccessDriveState(c.env, access.id, {
          drivePermissionId: previousPermissionId,
          driveError
        });
      }
    }
    const refreshed = await getProjectAccess(c.env, id, access.id);
    access = refreshed ?? access;
    return c.json({ ok: true, access, drive_error: driveError }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("Invalid invite email")) {
      return c.json({ error: "invalid_email" }, 400);
    }
    return c.json({ error: "access_upsert_failed" }, 400);
  }
});

projectsRoute.delete("/:id/access/:accessId", async (c) => {
  const id = c.req.param("id");
  const accessId = c.req.param("accessId");
  const ownerError = await requireOwner(c, id);
  if (ownerError) {
    return ownerError;
  }
  // project_id + id の両条件必須 (他 project の accessId 指定は 404)
  const existing = await getProjectAccess(c.env, id, accessId);
  if (!existing) {
    return c.json({ error: "not_found" }, 404);
  }

  // publicar 付与分 (drive_permission_id がある) だけ Drive を取り消す
  if (existing.drivePermissionId) {
    const project = await getProjectById(c.env, id);
    if (project?.driveFolderId) {
      try {
        await withProjectDriveAuth(c.env, project.id, project.createdBy, async (accessToken) => {
          await deleteDrivePermission(
            c.env,
            accessToken,
            project.driveFolderId!,
            existing.drivePermissionId!
          );
        });
      } catch (error) {
        // 取り消し失敗時は行を残し再試行可能にする (drive_permission_id を失わない)
        const driveError = driveErrorMessage(error, "revoke");
        await updateProjectAccessDriveState(c.env, accessId, {
          drivePermissionId: existing.drivePermissionId,
          driveError
        });
        return c.json({ error: "drive_revoke_failed", drive_error: driveError }, 502);
      }
    }
  }

  const deleted = await deleteProjectAccess(c.env, id, accessId);
  if (!deleted) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({ ok: true, drive_error: null });
});

projectsRoute.get("/:id/access-logs", async (c) => {
  const id = c.req.param("id");
  const role = await getProjectRole(c.env, id, c.get("user").id);
  if (!role) {
    return c.json({ error: "not_found" }, 404);
  }
  const limit = clampRequestLimit(c.req.query("limit") ?? undefined, 50);
  const cursor = c.req.query("cursor") ?? undefined;
  const { logs, nextCursor } = await listAccessLogs(c.env, id, { limit, cursor });
  return c.json({ logs, nextCursor });
});
