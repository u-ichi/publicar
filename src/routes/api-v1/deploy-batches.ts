import type { Context } from "hono";
import type { AppBindings } from "../../env";
import { getProjectById, normalizeFilePath } from "../../db/projects";
import { withServiceAccount } from "../../auth/service-account";
import { bytesToBase64Url } from "../../lib/encoding";
import { sha256Base64Url } from "../../lib/crypto";
import { randomId } from "../../lib/id";
import { parsePositiveInteger, projectUrl } from "../../lib/http";
import { boundedUploadBody, UploadInputError } from "../../lib/upload-body";
import { determineEntryPath, mimeFromPath } from "../../lib/zip";
import { getProjectStorage, assertStorageAccount, verifyServiceAccountLocation } from "../../storage/service-account-drive";
import { createTrackedFile, generateDriveIds } from "../../storage/drive-objects";
import { putCachedFile } from "../../storage/r2";
import { driveFailureResponse } from "./drive-errors";

export const UPLOAD_EXPIRY_MS = 15 * 60 * 1000;
const MANIFEST_BYTES = 128 * 1024;
type ManifestFile = { path: string; size_bytes: number; content_hash: string };
type Revision = { id: string; project_id: string; base_revision_id: string | null; request_hash: string; manifest_json: string | null;
  expires_at: number | null; published_at: number | null; response_json: string | null; drive_folder_id: string; service_account: string; entry_path: string };

class BatchError extends Error {
  constructor(message: string, public status: 400 | 401 | 403 | 404 | 409 | 410 | 503) { super(message); }
}

function principal(c: Context<AppBindings>) {
  const key = c.get("uploadKey");
  const userId = key ? null : c.get("user").id;
  const apiKeyId = c.get("apiKeyId");
  const sql = key ? `EXISTS (SELECT 1 FROM upload_keys k WHERE k.id = ? AND k.project_id = projects.id
    AND k.revoked_at IS NULL AND julianday(k.expires_at) > julianday('now'))` :
    `EXISTS (SELECT 1 FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = projects.id
      AND pm.user_id = ? AND pm.role IN ('owner', 'editor') AND u.disabled_at IS NULL AND u.kind = 'member')`;
  const apiSql = apiKeyId ? ` AND EXISTS (SELECT 1 FROM api_keys k WHERE k.id = ? AND k.user_id = ? AND k.revoked_at IS NULL
    AND (k.expires_at IS NULL OR julianday(k.expires_at) > julianday('now')) AND k.automation_grant_id IS NULL
    AND (k.project_id IS NULL OR k.project_id = projects.id) AND EXISTS (SELECT 1 FROM json_each(k.scopes) WHERE value = 'deploy'))` : "";
  return { actor: key ? `upload-key:${key.id}` : apiKeyId ? `api-key:${apiKeyId}` : `user:${userId}`,
    keyId: key?.id ?? null, userId, sql: sql + apiSql, bindings: [key?.id ?? userId, ...(apiKeyId ? [apiKeyId, userId] : [])] };
}

async function readManifest(c: Context<AppBindings>): Promise<ManifestFile[]> {
  if (c.req.header("Content-Type")?.split(";")[0].trim() !== "application/json") throw new BatchError("invalid_content_type", 400);
  const bytes = await boundedUploadBody(c.req.raw, MANIFEST_BYTES);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new BatchError("invalid_manifest", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "files") ||
      !("files" in value) || !Array.isArray(value.files) || !value.files.length) throw new BatchError("invalid_manifest", 400);
  if (value.files.length > parsePositiveInteger(c.env.MAX_UPLOAD_FILES, 200)) throw new UploadInputError("too_many_upload_files", 413);
  const paths = new Set<string>();
  let size = 0;
  const files: ManifestFile[] = [];
  for (const file of value.files) {
    if (!file || typeof file !== "object" || Array.isArray(file) || Object.keys(file).some(key => !["path", "size_bytes", "content_hash"].includes(key)) ||
        typeof file.path !== "string" || new TextEncoder().encode(file.path).byteLength > 512 || /[\u0000-\u001f\u007f]/.test(file.path) ||
        !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0 || typeof file.content_hash !== "string" ||
        !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(file.content_hash)) throw new BatchError("invalid_manifest", 400);
    const path = normalizeFilePath(file.path);
    if (!path || paths.has(path)) throw new BatchError("invalid_path", 400);
    paths.add(path);
    size += file.size_bytes;
    if (file.size_bytes > parsePositiveInteger(c.env.MAX_UPLOAD_BYTES, 5 * 1024 * 1024) ||
        size > parsePositiveInteger(c.env.MAX_EXPANDED_UPLOAD_BYTES, 20 * 1024 * 1024)) throw new UploadInputError("payload_too_large", 413);
    files.push({ path, size_bytes: file.size_bytes, content_hash: file.content_hash });
  }
  if (!determineEntryPath(files)) throw new BatchError("no_html_entry", 400);
  return files;
}

export async function deployBatches(c: Context<AppBindings>): Promise<Response> {
  const projectId = c.req.param("id")!;
  const requestId = c.req.header("Idempotency-Key") ?? "";
  const stage = c.req.query("stage");
  const auth = principal(c);
  const params = new URL(c.req.url).searchParams;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) return c.json({ error: "invalid_idempotency_key" }, 400);
  if (!["start", "file", "complete"].includes(stage ?? "") || [...params.keys()].some(name =>
    (name !== "stage" && !(stage === "file" && name === "path")) || params.getAll(name).length !== 1)) return c.json({ error: "invalid_deploy_parameter" }, 400);
  const load = () => c.env.DB.prepare("SELECT * FROM project_revisions WHERE project_id = ? AND actor_id = ? AND request_id = ?")
    .bind(projectId, auth.actor, requestId).first<Revision>();
  const authorized = async () => {
    if (!(await c.env.DB.prepare(`SELECT 1 FROM projects WHERE id = ? AND ${auth.sql}`).bind(projectId, ...auth.bindings).first())) {
      throw new BatchError(auth.keyId ? "invalid_upload_key" : "forbidden", auth.keyId ? 401 : 403);
    }
  };
  const unexpired = (revision: Revision) => {
    if (revision.published_at === null && (!revision.expires_at || revision.expires_at <= Date.now())) throw new BatchError("upload_expired", 410);
  };
  const live = async (revision: Revision) => {
    await authorized();
    unexpired(revision);
    assertStorageAccount(c.env, revision.service_account);
    if (!(await c.env.DB.prepare(`SELECT 1 FROM projects WHERE id = ? AND active_revision_id IS ? AND drive_folder_id = ? AND storage_service_account = ?`)
      .bind(projectId, revision.base_revision_id, revision.drive_folder_id, revision.service_account).first())) throw new BatchError("deployment_conflict", 409);
  };
  const priorStart = (revision: Revision, hash: string) => {
    if (revision.request_hash !== hash || !revision.manifest_json) throw new BatchError("idempotency_conflict", 409);
    unexpired(revision);
    return c.json(revision.published_at !== null ? JSON.parse(revision.response_json!) : { revision_id: revision.id, status: "uploading" });
  };
  try {
    if (stage === "start") {
      const files = await readManifest(c);
      const manifest = JSON.stringify(files);
      const hash = await sha256Base64Url(`split:${manifest}`);
      await authorized();
      const prior = await load();
      if (prior) return priorStart(prior, hash);
      const storage = await getProjectStorage(c.env, projectId);
      if (!storage?.storage_service_account || !storage.drive_folder_id) throw new BatchError("service_account_not_enabled", 503);
      assertStorageAccount(c.env, storage.storage_service_account);
      c.set("driveServiceAccount", storage.storage_service_account);
      const ids = await withServiceAccount(c.env, async token => {
        await verifyServiceAccountLocation(c.env, token, storage.drive_folder_id!);
        await authorized();
        return generateDriveIds(c.env, token, files.length);
      });
      const revisionId = randomId("rev");
      const now = Date.now();
      const objects = files.map((file, i) => ({ id: randomId("obj"), driveId: ids[i], path: file.path,
        r2Key: `projects/${projectId}/revisions/${revisionId}/${file.path}` }));
      const results = await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO project_revisions (id, project_id, base_revision_id, actor_id, upload_key_id, request_id, request_hash,
          created_at, manifest_json, expires_at, drive_folder_id, service_account, entry_path)
          SELECT ?, id, active_revision_id, ?, ?, ?, ?, ?, ?, ?, drive_folder_id, storage_service_account, ? FROM projects
          WHERE id = ? AND active_revision_id IS ? AND drive_folder_id = ? AND storage_service_account = ? AND ${auth.sql}
          ON CONFLICT(project_id, actor_id, request_id) DO NOTHING`)
          .bind(revisionId, auth.actor, auth.keyId, requestId, hash, now, manifest, now + UPLOAD_EXPIRY_MS, determineEntryPath(files),
            projectId, storage.active_revision_id, storage.drive_folder_id, storage.storage_service_account, ...auth.bindings),
        c.env.DB.prepare(`INSERT INTO upload_objects (id, project_id, revision_id, drive_folder_id, drive_file_id, r2_key, service_account, created_at, operation_id)
          SELECT json_extract(value, '$.id'), r.project_id, r.id, r.drive_folder_id, json_extract(value, '$.driveId'), json_extract(value, '$.r2Key'),
            r.service_account, r.created_at, json_extract(value, '$.id') FROM project_revisions r, json_each(?) WHERE r.id = ?`)
          .bind(JSON.stringify(objects), revisionId)
      ]);
      if (results[0].meta.changes) return c.json({ revision_id: revisionId, status: "uploading" }, 201);
      await authorized();
      const winner = await load();
      if (winner) return priorStart(winner, hash);
      throw new BatchError("deployment_conflict", 409);
    }
    let revision = await load();
    if (!revision) throw new BatchError("upload_not_found", 404);
    if (!revision.manifest_json) throw new BatchError("idempotency_conflict", 409);
    unexpired(revision);
    const files = JSON.parse(revision.manifest_json) as ManifestFile[];
    if (stage === "file") {
      const path = normalizeFilePath(c.req.query("path") ?? "");
      const file = files.find(file => file.path === path);
      if (!file) throw new BatchError("invalid_path", 400);
      const body = await boundedUploadBody(c.req.raw, Math.min(file.size_bytes, parsePositiveInteger(c.env.MAX_UPLOAD_BYTES, 5 * 1024 * 1024)), true);
      const hash = bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
      if (body.byteLength !== file.size_bytes || hash !== file.content_hash) throw new BatchError("file_content_mismatch", 400);
      await authorized();
      if (revision.published_at !== null) return c.json({ ok: true, path });
      await live(revision);
      if (await c.env.DB.prepare("SELECT 1 FROM upload_parts WHERE revision_id = ? AND path = ?").bind(revision.id, path).first()) return c.json({ ok: true, path });
      const r2Key = `projects/${projectId}/revisions/${revision.id}/${path}`;
      const object = await c.env.DB.prepare("SELECT id, drive_file_id FROM upload_objects WHERE revision_id = ? AND r2_key = ?")
        .bind(revision.id, r2Key).first<{ id: string; drive_file_id: string }>();
      if (!object) throw new BatchError("upload_not_found", 404);
      const mimeType = mimeFromPath(file.path);
      c.set("driveServiceAccount", revision.service_account);
      const drive = await withServiceAccount(c.env, async token => {
        await verifyServiceAccountLocation(c.env, token, revision!.drive_folder_id);
        await live(revision!);
        return createTrackedFile(c.env, token, { id: object.drive_file_id, parentId: revision!.drive_folder_id, operationId: object.id,
          path: file.path, mimeType, body, contentHash: file.content_hash });
      });
      await live(revision);
      const etag = await putCachedFile(c.env, r2Key, body, mimeType);
      if (!etag) throw new Error("cache_write_failed");
      const stored = await c.env.DB.prepare(`INSERT INTO upload_parts (revision_id, path, object_id, drive_modified_time, cache_etag)
        SELECT r.id, ?, ?, ?, ? FROM project_revisions r JOIN projects ON projects.id = r.project_id
        WHERE r.id = ? AND r.published_at IS NULL AND r.expires_at > unixepoch('subsec') * 1000
          AND projects.active_revision_id IS r.base_revision_id AND projects.drive_folder_id = r.drive_folder_id
          AND projects.storage_service_account = r.service_account AND ${auth.sql}
        ON CONFLICT(revision_id, path) DO NOTHING`)
        .bind(path, object.id, drive.modifiedTime ?? null, etag, revision.id, ...auth.bindings).run();
      if (!stored.meta.changes) {
        revision = (await load())!;
        await authorized();
        if (revision.published_at === null) await live(revision);
        if (!(await c.env.DB.prepare("SELECT 1 FROM upload_parts WHERE revision_id = ? AND path = ?").bind(revision.id, path).first())) throw new BatchError("deployment_conflict", 409);
      }
      return c.json({ ok: true, path });
    }
    await boundedUploadBody(c.req.raw, 0, true);
    await authorized();
    if (revision.published_at !== null) return c.json(JSON.parse(revision.response_json!));
    assertStorageAccount(c.env, revision.service_account);
    const project = await getProjectById(c.env, projectId);
    if (!project) throw new BatchError("upload_not_found", 404);
    const response = { ok: true, files: files.length, entry_path: revision.entry_path, url: projectUrl(c.req.raw, project.alias), revision_id: revision.id };
    // 最初の条件付き更新に成功した要求だけが、同じtransaction内の全変更を行う。
    const active = "EXISTS (SELECT 1 FROM projects WHERE id = ? AND active_revision_id = ?) AND EXISTS (SELECT 1 FROM project_revisions WHERE id = ? AND published_at IS NULL)";
    const activeBindings = [projectId, revision.id, revision.id];
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE projects SET active_revision_id = ?, entry_path = ?, updated_at = datetime('now')
        WHERE id = ? AND active_revision_id IS ? AND drive_folder_id = ? AND storage_service_account = ? AND ${auth.sql}
        AND EXISTS (SELECT 1 FROM project_revisions r WHERE r.id = ? AND r.published_at IS NULL AND r.expires_at > unixepoch('subsec') * 1000
          AND (SELECT count(*) FROM upload_parts WHERE revision_id = r.id) = json_array_length(r.manifest_json))`)
        .bind(revision.id, revision.entry_path, projectId, revision.base_revision_id, revision.drive_folder_id, revision.service_account, ...auth.bindings, revision.id),
      c.env.DB.prepare(`INSERT INTO upload_objects (id, project_id, revision_id, drive_folder_id, drive_file_id, r2_key, service_account, created_at)
        SELECT 'cleanup_' || id, project_id, ?, ?, drive_file_id, r2_key, ?, unixepoch('subsec') * 1000 FROM project_files WHERE project_id = ? AND ${active}
        ON CONFLICT(r2_key) DO NOTHING`).bind(revision.base_revision_id ?? "legacy", revision.drive_folder_id, revision.service_account, projectId, ...activeBindings),
      c.env.DB.prepare(`DELETE FROM project_files WHERE project_id = ? AND ${active}`).bind(projectId, ...activeBindings),
      c.env.DB.prepare(`INSERT INTO project_files (id, project_id, path, drive_file_id, drive_owner_user_id, r2_key, size_bytes, content_hash, mime_type, drive_modified_time, cache_etag)
        SELECT 'file_' || o.id, ?, p.path, o.drive_file_id, ?, o.r2_key, json_extract(f.value, '$.size_bytes'), json_extract(f.value, '$.content_hash'),
          json_extract(f.value, '$.mime_type'), p.drive_modified_time, p.cache_etag
        FROM upload_parts p JOIN upload_objects o ON o.id = p.object_id, json_each(?) f
        WHERE p.revision_id = ? AND p.path = json_extract(f.value, '$.path') AND ${active}`)
        .bind(projectId, auth.userId, JSON.stringify(files.map(file => ({ ...file, mime_type: mimeFromPath(file.path) }))), revision.id, ...activeBindings),
      c.env.DB.prepare(`INSERT INTO deploy_events (id, project_id, deployer_user_id, deploy_type, files_count, total_size_bytes, content_hash, upload_key_id, service_account, revision_id)
        SELECT ?, ?, ?, 'zip', ?, ?, ?, ?, ?, ? WHERE ${active}`)
        .bind(randomId("dep"), projectId, auth.userId, files.length, files.reduce((sum, f) => sum + f.size_bytes, 0), revision.request_hash,
          auth.keyId, revision.service_account, revision.id, ...activeBindings),
      c.env.DB.prepare(`UPDATE project_revisions SET response_json = ?, published_at = unixepoch('subsec') * 1000 WHERE id = ? AND ${active}`)
        .bind(JSON.stringify(response), revision.id, ...activeBindings)
    ]);
    if (results[0].meta.changes) return c.json(response);
    await authorized();
    revision = (await load())!;
    if (revision.published_at !== null) return c.json(JSON.parse(revision.response_json!));
    await live(revision);
    throw new BatchError("upload_incomplete", 409);
  } catch (error) {
    if (error instanceof BatchError || error instanceof UploadInputError) return c.json({ error: error.message }, error.status);
    return driveFailureResponse(c, error) ?? c.json({ error: "deployment_failed" }, 502);
  }
}
