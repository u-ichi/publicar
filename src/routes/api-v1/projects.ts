import { Hono } from "hono";
import { listAccessLogs } from "../../db/access-logs";
import {
  canOwnProject,
  countProjectOwners,
  createProject,
  deleteProject,
  deleteProjectMember,
  getProjectForUser,
  getProjectRole,
  isProjectVisibility,
  isValidAlias,
  listProjectsForUser,
  listProjectMembers,
  normalizeFilePath,
  updateProject,
  updateProjectMemberRole,
  upsertProjectMember,
  type ProjectRole
} from "../../db/projects";
import { getUserByEmail } from "../../db/users";
import type { AppBindings } from "../../env";
import { withDriveAuthRetry } from "../../lib/drive-retry";
import { jsonArray, projectUrl } from "../../lib/http";
import { clampRequestLimit, nullableStringValue, readJsonObject, stringValue } from "../../lib/request";
import { deleteCachedFile, deleteCachedPrefix } from "../../storage/r2";
import { deleteProjectFile, getProjectFile, listProjectFilesWithDeployers, r2KeyForProjectFile } from "../../db/project-files";
import { trashDriveFile } from "../../storage/drive";
import { driveDeleteFailureResponse } from "./drive-errors";
import { requireOwner } from "./guards";

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
  try {
    if (file.driveFileId) {
      const driveFileId = file.driveFileId;
      await withDriveAuthRetry(c.env, ownerUserId, async (accessToken) => {
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
  await deleteCachedFile(c.env, file.r2Key);
  await deleteProjectFile(c.env, id, path);
  return c.json({ ok: true, deleted: true });
});

projectsRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const project = await getProjectForUser(c.env, id, c.get("user").id);
  const role = project?.role ?? null;
  if (!project || !canOwnProject(role)) {
    return c.json({ error: role ? "forbidden" : "not_found" }, role ? 403 : 404);
  }
  if (project.driveFolderId) {
    const driveFolderId = project.driveFolderId;
    try {
      await withDriveAuthRetry(c.env, project.createdBy, async (accessToken) => {
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
  await deleteCachedPrefix(c.env, `projects/${id}/`);
  await deleteProject(c.env, id);
  return c.json({ ok: true, deleted: true });
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
