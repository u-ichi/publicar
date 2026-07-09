import type { Context } from "hono";
import { insertDeployEvent } from "../../db/deploy-events";
import { deleteProjectFile, getProjectFile, listProjectFiles, r2KeyForProjectFile, upsertProjectFile } from "../../db/project-files";
import { canEditProject, getProjectById, getProjectRole, normalizeFilePath, updateProject } from "../../db/projects";
import type { AppBindings, Env } from "../../env";
import { withDriveAuthRetry } from "../../lib/drive-retry";
import { bytesToBase64Url } from "../../lib/encoding";
import { parsePositiveInteger, projectUrl } from "../../lib/http";
import { determineEntryPath, extractZip, type ZipEntry } from "../../lib/zip";
import { createDriveFolder, trashDriveFile, uploadDriveFile } from "../../storage/drive";
import { deleteCachedFile, putCachedFile } from "../../storage/r2";
import { driveFailureResponse } from "./drive-errors";
import { roleErrorResponse } from "./guards";

const DEFAULT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

function uploadLimit(env: Env): number {
  return parsePositiveInteger(env.MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES);
}

function fileNameFromPath(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || "index.html";
}

function isZipDeploy(c: Context<AppBindings>): boolean {
  return (c.req.query("name") ?? "").toLowerCase().endsWith(".zip");
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

async function sha256Digest(body: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body);
  return bytesToBase64Url(new Uint8Array(digest));
}

async function readUploadBody(c: Context<AppBindings>): Promise<ArrayBuffer | Response> {
  const contentLength = c.req.header("Content-Length");
  const maxBytes = uploadLimit(c.env);
  if (contentLength && Number(contentLength) > maxBytes) {
    return c.json({ error: "payload_too_large" }, 413);
  }
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) {
    return c.json({ error: "empty_upload" }, 400);
  }
  if (body.byteLength > maxBytes) {
    return c.json({ error: "payload_too_large" }, 413);
  }
  return body;
}

function isDriveConfigured(env: Env): boolean {
  return env.DEV_MODE === "true" || !!env.TEAM_DRIVE_ID;
}

async function ensureProjectDriveFolder(c: Context<AppBindings>, project: NonNullable<Awaited<ReturnType<typeof getProjectById>>>): Promise<{
  accessToken: string;
  folderId: string | null;
}> {
  const userId = c.get("user").id;
  let accessToken = "";
  let folderId = project.driveFolderId;
  if (!folderId) {
    folderId = await withDriveAuthRetry(c.env, userId, async (token) => {
      accessToken = token;
      const folder = await createDriveFolder(c.env, accessToken, project.alias);
      await updateProject(c.env, project.id, { driveFolderId: folder.id });
      return folder.id;
    });
  } else {
    accessToken = await withDriveAuthRetry(c.env, userId, async (token) => token);
  }
  return { accessToken, folderId };
}

async function uploadProjectFile(
  c: Context<AppBindings>,
  input: {
    projectId: string;
    path: string;
    folderId: string | null;
    accessToken: string;
    body: ArrayBuffer;
    contentType: string;
  }
) {
  const previousFile = await getProjectFile(c.env, input.projectId, input.path);
  const driveFile = await withDriveAuthRetry(c.env, c.get("user").id, async (accessToken) => {
    return uploadDriveFile(c.env, accessToken, {
      fileId: previousFile?.driveFileId,
      parentId: input.folderId,
      name: fileNameFromPath(input.path),
      mimeType: input.contentType,
      body: input.body
    });
  }, { initialAccessToken: input.accessToken });

  const cacheEtag = await putCachedFile(c.env, previousFile?.r2Key ?? r2KeyForProjectFile(input.projectId, input.path), input.body, input.contentType);
  return upsertProjectFile(c.env, {
    projectId: input.projectId,
    path: input.path,
    driveFileId: driveFile.id,
    driveOwnerUserId: c.get("user").id,
    sizeBytes: input.body.byteLength,
    contentHash: await sha256Digest(input.body),
    mimeType: input.contentType,
    driveModifiedTime: driveFile.modifiedTime ?? null,
    cacheEtag
  });
}

async function trashStaleFile(c: Context<AppBindings>, projectId: string, path: string): Promise<void> {
  const file = await getProjectFile(c.env, projectId, path);
  if (file?.driveFileId) {
    const driveFileId = file.driveFileId;
    await withDriveAuthRetry(c.env, file.driveOwnerUserId ?? c.get("user").id, async (accessToken) => {
      return trashDriveFile(c.env, accessToken, driveFileId);
    });
  }
  await deleteCachedFile(c.env, r2KeyForProjectFile(projectId, path));
  await deleteProjectFile(c.env, projectId, path);
}

function normalizeZipEntries(entries: ZipEntry[]): Array<ZipEntry & { path: string }> | null {
  const paths = new Set<string>();
  const normalizedEntries: Array<ZipEntry & { path: string }> = [];
  for (const entry of entries) {
    const path = normalizeFilePath(entry.path);
    if (!path || paths.has(path)) {
      return null;
    }
    paths.add(path);
    normalizedEntries.push({ ...entry, path });
  }
  return normalizedEntries;
}

export async function deployProject(c: Context<AppBindings>): Promise<Response> {
  if (!isDriveConfigured(c.env)) {
    return c.json({ error: "team_drive_not_configured" }, 503);
  }
  const projectId = c.req.param("id");
  if (!projectId) {
    return c.json({ error: "not_found" }, 404);
  }
  const role = await getProjectRole(c.env, projectId, c.get("user").id);
  if (!canEditProject(role)) {
    return roleErrorResponse(c, role);
  }
  const project = await getProjectById(c.env, projectId);
  if (!project) {
    return c.json({ error: "not_found" }, 404);
  }
  if (isZipDeploy(c)) {
    const body = await readUploadBody(c);
    if (body instanceof Response) {
      return body;
    }
    let extractedEntries: ZipEntry[];
    try {
      extractedEntries = extractZip(body);
    } catch {
      return c.json({ error: "invalid_zip" }, 400);
    }
    const entries = normalizeZipEntries(extractedEntries);
    if (!entries) {
      return c.json({ error: "invalid_zip_path" }, 400);
    }
    if (entries.length === 0) {
      return c.json({ error: "empty_zip" }, 400);
    }
    const entryPath = determineEntryPath(entries);
    if (!entryPath) {
      return c.json({ error: "no_html_entry" }, 400);
    }
    try {
      const existingFiles = await listProjectFiles(c.env, project.id);
      const { accessToken, folderId } = await ensureProjectDriveFolder(c, project);
      for (const entry of entries) {
        await uploadProjectFile(c, {
          projectId: project.id,
          path: entry.path,
          folderId,
          accessToken,
          body: bytesToArrayBuffer(entry.data),
          contentType: entry.mimeType
        });
      }
      const deployedPaths = new Set(entries.map((entry) => entry.path));
      for (const file of existingFiles) {
        if (!deployedPaths.has(file.path)) {
          await trashStaleFile(c, project.id, file.path);
        }
      }
      await updateProject(c.env, project.id, { entryPath });
    } catch (error) {
      const response = driveFailureResponse(c, error);
      if (response) {
        return response;
      }
      throw error;
    }
    await insertDeployEvent(c.env, {
      projectId: project.id,
      deployerUserId: c.get("user").id,
      deployType: "zip",
      path: null,
      filesCount: entries.length,
      totalSizeBytes: entries.reduce((sum, entry) => sum + entry.data.byteLength, 0),
      contentHash: null
    });
    return c.json({
      ok: true,
      files: entries.length,
      entry_path: entryPath,
      url: projectUrl(c.req.raw, project.alias)
    });
  }
  const path = normalizeFilePath(c.req.query("path") ?? project.entryPath);
  if (!path) {
    return c.json({ error: "invalid_path" }, 400);
  }
  const body = await readUploadBody(c);
  if (body instanceof Response) {
    return body;
  }
  const contentType = c.req.header("Content-Type")?.split(";")[0] || "application/octet-stream";
  try {
    const { accessToken, folderId } = await ensureProjectDriveFolder(c, project);
    const file = await uploadProjectFile(c, {
      projectId: project.id,
      path,
      folderId,
      accessToken,
      body,
      contentType
    });
    await insertDeployEvent(c.env, {
      projectId: project.id,
      deployerUserId: c.get("user").id,
      deployType: "file",
      path,
      filesCount: 1,
      totalSizeBytes: body.byteLength,
      contentHash: await sha256Digest(body)
    });
    return c.json({
      ok: true,
      file,
      entry: project.entryPath,
      url: projectUrl(c.req.raw, project.alias)
    });
  } catch (error) {
    const response = driveFailureResponse(c, error);
    if (response) {
      return response;
    }
    throw error;
  }
}
