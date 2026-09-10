import type { Context } from "hono";
import type { AppBindings } from "../../env";
import { withServiceAccount } from "../../auth/service-account";
import { getProjectById, getProjectRole, canEditProject, normalizeFilePath } from "../../db/projects";
import { listProjectFiles, type ProjectFile } from "../../db/project-files";
import { bytesToBase64Url } from "../../lib/encoding";
import { sha256Base64Url } from "../../lib/crypto";
import { randomId } from "../../lib/id";
import { parsePositiveInteger, projectUrl } from "../../lib/http";
import { boundedUploadBody, UploadInputError } from "../../lib/upload-body";
import { determineEntryPath, extractZip } from "../../lib/zip";
import { uploadDriveFile } from "../../storage/drive";
import { getProjectStorage, verifyServiceAccountLocation, assertStorageAccount } from "../../storage/service-account-drive";
import { putCachedFile } from "../../storage/r2";
import { driveFailureResponse } from "./drive-errors";

export const MAX_DEPLOY_MILLISECONDS = 5 * 60 * 1000;

export async function deployServiceAccount(c: Context<AppBindings>): Promise<Response> {
  const started = Date.now();
  const key = c.get("uploadKey");
  const user = c.get("user");
  const projectId = c.req.param("id")!;
  const actor = key ? `upload-key:${key.id}` : c.get("apiKeyId") ? `api-key:${c.get("apiKeyId")}` : `user:${user.id}`;
  if (!key && !canEditProject(await getProjectRole(c.env, projectId, user.id))) return c.json({ error: "forbidden" }, 403);
  const storage = await getProjectStorage(c.env, projectId);
  const project = await getProjectById(c.env, projectId);
  if (!project) return c.json({ error: "not_found" }, 404);
  const requestId = c.req.header("Idempotency-Key") ?? (key ? "" : randomId("request"));
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) return c.json({ error: "invalid_idempotency_key" }, 400);
  const isZip = (c.req.query("name") ?? "").toLowerCase().endsWith(".zip");
  const path = normalizeFilePath(c.req.query("path") ?? project.entryPath);
  if (!path) return c.json({ error: "invalid_path" }, 400);
  if (Array.from(new URL(c.req.url).searchParams.keys()).some((name) => name !== "path" && name !== "name")) return c.json({ error: "invalid_deploy_parameter" }, 400);
  const contentType = c.req.header("Content-Type")?.split(";")[0].trim() || "application/octet-stream";
  if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(contentType)) return c.json({ error: "invalid_content_type" }, 400);
  try {
    if (!storage?.storage_service_account || !storage.drive_folder_id) return c.json({ error: "service_account_not_enabled" }, 503);
    assertStorageAccount(c.env, storage.storage_service_account);
    const body = await boundedUploadBody(c.req.raw, parsePositiveInteger(c.env.MAX_UPLOAD_BYTES, 5 * 1024 * 1024));
    const contentHash = bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
    const requestHash = await sha256Base64Url(JSON.stringify({ contentHash, isZip, path: isZip ? null : c.req.query("path") ?? null, contentType }));
    const priorResult = async (): Promise<Response | null> => {
      const prior = await c.env.DB.prepare("SELECT request_hash, response_json FROM project_revisions WHERE project_id = ? AND actor_id = ? AND request_id = ?")
        .bind(projectId, actor, requestId).first<{ request_hash: string; response_json: string }>();
      if (!prior) return null;
      return prior.request_hash === requestHash ? c.json(JSON.parse(prior.response_json)) : c.json({ error: "idempotency_conflict" }, 409);
    };
    const prior = await priorResult();
    if (prior) return prior;
    const entries = isZip ? extractZip(body, { bytes: parsePositiveInteger(c.env.MAX_EXPANDED_UPLOAD_BYTES, 20 * 1024 * 1024), files: parsePositiveInteger(c.env.MAX_UPLOAD_FILES, 200) }) :
      [{ path, data: new Uint8Array(body), mimeType: contentType }];
    if (!entries.length) throw new UploadInputError("empty_zip");
    const entryPath = isZip ? determineEntryPath(entries) : project.entryPath;
    if (!entryPath) throw new UploadInputError("no_html_entry");
    const account = storage.storage_service_account!;
    const folderId = storage.drive_folder_id!;
    const revisionId = randomId("rev");
    const existing = await listProjectFiles(c.env, projectId);
    // 配信中の旧ファイルも記録し、どの公開版からも参照されなくなってから整理する。
    for (const file of existing) {
      if (file.driveFileId) await c.env.DB.prepare(`INSERT INTO upload_objects
        (id, project_id, revision_id, drive_folder_id, drive_file_id, r2_key, service_account, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(r2_key) DO NOTHING`)
        .bind(randomId("obj"), projectId, storage.active_revision_id ?? "legacy", folderId, file.driveFileId, file.r2Key, account, started).run();
    }
    const manifest = new Map<string, ProjectFile>(isZip ? [] : existing.map((file) => [file.path, file]));
    c.set("driveServiceAccount", account);
    await withServiceAccount(c.env, (token) => verifyServiceAccountLocation(c.env, token, folderId));
    for (const entry of entries) {
      if (Date.now() - started > MAX_DEPLOY_MILLISECONDS) throw new Error("deployment_timed_out");
      const objectId = randomId("obj");
      const r2Key = `projects/${projectId}/revisions/${revisionId}/${entry.path}`;
      await c.env.DB.prepare(`INSERT INTO upload_objects (id, project_id, revision_id, drive_folder_id, r2_key, service_account, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(objectId, projectId, revisionId, folderId, r2Key, account, Date.now()).run();
      const fileBody = new Uint8Array(entry.data).buffer;
      const drive = await withServiceAccount(c.env, (token) => uploadDriveFile(c.env, token, { parentId: folderId, name: entry.path.split("/").pop()!, mimeType: entry.mimeType, body: fileBody, uploadObjectId: objectId }));
      await c.env.DB.prepare("UPDATE upload_objects SET drive_file_id = ? WHERE id = ?").bind(drive.id, objectId).run();
      const etag = await putCachedFile(c.env, r2Key, fileBody, entry.mimeType);
      if (!etag) throw new Error("cache_write_failed");
      manifest.set(entry.path, { id: randomId("file"), projectId, path: entry.path, driveFileId: drive.id, driveOwnerUserId: key ? null : user.id,
        r2Key, sizeBytes: fileBody.byteLength, contentHash: bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", fileBody))),
        mimeType: entry.mimeType, driveModifiedTime: drive.modifiedTime ?? null, cacheEtag: etag });
    }
    const totalSize = entries.reduce((sum, entry) => sum + entry.data.byteLength, 0);
    const response = isZip ? { ok: true, files: entries.length, entry_path: entryPath, url: projectUrl(c.req.raw, project.alias), revision_id: revisionId } :
      { ok: true, file: manifest.get(path), entry: entryPath, url: projectUrl(c.req.raw, project.alias), revision_id: revisionId };
    // この更新とファイル一覧・履歴を同じD1トランザクションで確定する。Google/R2呼出しを含めない。
    const authorization = key ? `EXISTS (SELECT 1 FROM upload_keys WHERE id = ? AND project_id = projects.id AND revoked_at IS NULL AND julianday(expires_at) > julianday('now'))` :
      `EXISTS (SELECT 1 FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = projects.id AND pm.user_id = ? AND pm.role IN ('owner', 'editor') AND u.disabled_at IS NULL)`;
    const apiKeyCheck = c.get("apiKeyId") ? `AND EXISTS (SELECT 1 FROM api_keys WHERE id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR julianday(expires_at) > julianday('now')))` : "";
    const publish = c.env.DB.prepare(`UPDATE projects SET active_revision_id = ?, entry_path = ?, updated_at = datetime('now')
      WHERE id = ? AND active_revision_id IS ? AND storage_service_account = ? AND drive_folder_id = ?
      AND ${authorization} ${apiKeyCheck} AND unixepoch() * 1000 <= ?
      AND NOT EXISTS (SELECT 1 FROM project_revisions WHERE project_id = projects.id AND actor_id = ? AND request_id = ?)`)
      .bind(revisionId, entryPath, projectId, storage.active_revision_id, account, folderId, key?.id ?? user.id,
        ...(c.get("apiKeyId") ? [c.get("apiKeyId")!] : []), started + MAX_DEPLOY_MILLISECONDS, actor, requestId);
    const active = "EXISTS (SELECT 1 FROM projects WHERE id = ? AND active_revision_id = ?)";
    const results = await c.env.DB.batch([
      publish,
      c.env.DB.prepare(`INSERT INTO project_revisions (id, project_id, base_revision_id, actor_id, upload_key_id, request_id, request_hash, response_json, created_at, published_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch() * 1000 WHERE ${active}`)
        .bind(revisionId, projectId, storage.active_revision_id, actor, key?.id ?? null, requestId, requestHash, JSON.stringify(response), started, projectId, revisionId),
      c.env.DB.prepare(`DELETE FROM project_files WHERE project_id = ? AND ${active}`).bind(projectId, projectId, revisionId),
      c.env.DB.prepare(`INSERT INTO project_files (id, project_id, path, drive_file_id, drive_owner_user_id, r2_key, size_bytes, content_hash, mime_type, drive_modified_time, cache_etag)
        SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.path'), json_extract(value, '$.driveFileId'), json_extract(value, '$.driveOwnerUserId'),
        json_extract(value, '$.r2Key'), json_extract(value, '$.sizeBytes'), json_extract(value, '$.contentHash'), json_extract(value, '$.mimeType'),
        json_extract(value, '$.driveModifiedTime'), json_extract(value, '$.cacheEtag') FROM json_each(?) WHERE ${active}`)
        .bind(projectId, JSON.stringify([...manifest.values()]), projectId, revisionId),
      c.env.DB.prepare(`INSERT INTO deploy_events (id, project_id, deployer_user_id, deploy_type, path, files_count, total_size_bytes, content_hash, upload_key_id, service_account, revision_id)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${active}`)
        .bind(randomId("dep"), projectId, key ? null : user.id, isZip ? "zip" : "file", isZip ? null : path, entries.length, totalSize, contentHash, key?.id ?? null, account, revisionId, projectId, revisionId)
    ]);
    if (results[0].meta.changes) return c.json(response);
    if (key) {
      const activeKey = await c.env.DB.prepare("SELECT 1 FROM upload_keys WHERE id = ? AND revoked_at IS NULL AND julianday(expires_at) > julianday('now')").bind(key.id).first();
      if (!activeKey) return c.json({ error: "invalid_upload_key" }, 401);
    }
    return await priorResult() ?? c.json({ error: "deployment_conflict" }, 409);
  } catch (error) {
    if (error instanceof UploadInputError) return c.json({ error: error.message }, error.status);
    return driveFailureResponse(c, error) ?? c.json({ error: "deployment_failed" }, 502);
  }
}
