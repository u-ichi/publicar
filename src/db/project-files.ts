import type { Env } from "../env";
import { randomId } from "../lib/id";
import { normalizeFilePath } from "./projects";

export type ProjectFile = {
  id: string;
  projectId: string;
  path: string;
  driveFileId: string | null;
  driveOwnerUserId: string | null;
  r2Key: string;
  sizeBytes: number;
  contentHash: string | null;
  mimeType: string;
  driveModifiedTime: string | null;
  cacheEtag: string | null;
};

export type ProjectFileWithDeployer = ProjectFile & {
  deployerEmail: string | null;
  deployerName: string | null;
  deployerAvatarUrl: string | null;
};

type ProjectFileRow = {
  id: string;
  project_id: string;
  path: string;
  drive_file_id: string | null;
  drive_owner_user_id: string | null;
  r2_key: string;
  size_bytes: number;
  content_hash: string | null;
  mime_type: string;
  drive_modified_time: string | null;
  cache_etag: string | null;
};

type ProjectFileWithDeployerRow = ProjectFileRow & {
  deployer_email: string | null;
  deployer_name: string | null;
  deployer_avatar_url: string | null;
};

function rowToProjectFile(row: ProjectFileRow): ProjectFile {
  return {
    id: row.id,
    projectId: row.project_id,
    path: row.path,
    driveFileId: row.drive_file_id,
    driveOwnerUserId: row.drive_owner_user_id,
    r2Key: row.r2_key,
    sizeBytes: row.size_bytes,
    contentHash: row.content_hash,
    mimeType: row.mime_type,
    driveModifiedTime: row.drive_modified_time,
    cacheEtag: row.cache_etag
  };
}

function rowToProjectFileWithDeployer(row: ProjectFileWithDeployerRow): ProjectFileWithDeployer {
  return {
    ...rowToProjectFile(row),
    deployerEmail: row.deployer_email,
    deployerName: row.deployer_name,
    deployerAvatarUrl: row.deployer_avatar_url
  };
}

export function r2KeyForProjectFile(projectId: string, path: string): string {
  return `projects/${projectId}/${path}`;
}

export async function getProjectFile(env: Env, projectId: string, path: string): Promise<ProjectFile | null> {
  const normalized = normalizeFilePath(path);
  if (!normalized) {
    return null;
  }
  const row = await env.DB.prepare("SELECT * FROM project_files WHERE project_id = ? AND path = ?")
    .bind(projectId, normalized)
    .first<ProjectFileRow>();
  return row ? rowToProjectFile(row) : null;
}

export async function listProjectFiles(env: Env, projectId: string): Promise<ProjectFile[]> {
  const result = await env.DB.prepare("SELECT * FROM project_files WHERE project_id = ? ORDER BY path ASC")
    .bind(projectId)
    .all<ProjectFileRow>();
  return result.results.map(rowToProjectFile);
}

export async function listProjectFilesWithDeployers(env: Env, projectId: string): Promise<ProjectFileWithDeployer[]> {
  const result = await env.DB.prepare(
    `SELECT
      pf.*,
      u.email AS deployer_email,
      u.name AS deployer_name,
      u.avatar_url AS deployer_avatar_url
     FROM project_files pf
     LEFT JOIN users u ON u.id = pf.drive_owner_user_id
     WHERE pf.project_id = ?
     ORDER BY pf.drive_modified_time DESC, pf.path ASC`
  )
    .bind(projectId)
    .all<ProjectFileWithDeployerRow>();
  return result.results.map(rowToProjectFileWithDeployer);
}

export async function deleteProjectFile(env: Env, projectId: string, path: string): Promise<ProjectFile | null> {
  const normalized = normalizeFilePath(path);
  if (!normalized) {
    return null;
  }
  const row = await env.DB.prepare("DELETE FROM project_files WHERE project_id = ? AND path = ? RETURNING *")
    .bind(projectId, normalized)
    .first<ProjectFileRow>();
  return row ? rowToProjectFile(row) : null;
}

export async function upsertProjectFile(
  env: Env,
  input: {
    projectId: string;
    path: string;
    driveFileId: string;
    driveOwnerUserId: string;
    sizeBytes: number;
    contentHash: string;
    mimeType: string;
    driveModifiedTime: string | null;
    cacheEtag: string | null;
  }
): Promise<ProjectFile> {
  const normalized = normalizeFilePath(input.path);
  if (!normalized) {
    throw new Error("Invalid file path");
  }
  const r2Key = r2KeyForProjectFile(input.projectId, normalized);
  const row = await env.DB.prepare(
    `INSERT INTO project_files (
      id, project_id, path, drive_file_id, drive_owner_user_id, r2_key,
      size_bytes, content_hash, mime_type, drive_modified_time, cache_etag, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project_id, path) DO UPDATE SET
      drive_file_id = excluded.drive_file_id,
      drive_owner_user_id = excluded.drive_owner_user_id,
      r2_key = excluded.r2_key,
      size_bytes = excluded.size_bytes,
      content_hash = excluded.content_hash,
      mime_type = excluded.mime_type,
      drive_modified_time = excluded.drive_modified_time,
      cache_etag = excluded.cache_etag,
      updated_at = datetime('now')
    RETURNING *`
  )
    .bind(
      randomId("file"),
      input.projectId,
      normalized,
      input.driveFileId,
      input.driveOwnerUserId,
      r2Key,
      input.sizeBytes,
      input.contentHash,
      input.mimeType,
      input.driveModifiedTime,
      input.cacheEtag
    )
    .first<ProjectFileRow>();
  if (!row) {
    throw new Error("Failed to upsert project file");
  }
  return rowToProjectFile(row);
}
