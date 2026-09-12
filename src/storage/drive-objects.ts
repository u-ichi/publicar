import type { Env } from "../env";
import { bytesToBase64Url } from "../lib/encoding";
import { boundedUploadBody } from "../lib/upload-body";
import { createDriveFolder, uploadDriveFile, type DriveFile } from "./drive";

export async function generateDriveIds(env: Env, token: string, count: number): Promise<string[]> {
  const url = new URL(`${env.GOOGLE_DRIVE_API_BASE_URL ?? "https://www.googleapis.com/drive/v3"}/files/generateIds`);
  url.searchParams.set("count", String(count));
  url.searchParams.set("space", "drive");
  url.searchParams.set("type", "files");
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Drive ID generation failed with ${response.status}`);
  const result = await response.json<{ ids?: string[] }>();
  if (!Array.isArray(result.ids) || result.ids.length !== count || new Set(result.ids).size !== count ||
      result.ids.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id))) throw new Error("Drive ID generation failed: invalid IDs");
  return result.ids;
}

type ObjectMetadata = DriveFile & { driveId?: string; parents?: string[]; appProperties?: Record<string, string>;
  sha256Checksum?: string; capabilities?: { canTrash?: boolean } };

export async function verifyDriveObject(env: Env, token: string, input: {
  id: string; parentId: string; operationId: string; folder?: boolean; allowTrashed?: boolean;
}): Promise<ObjectMetadata> {
  const url = new URL(`${env.GOOGLE_DRIVE_API_BASE_URL ?? "https://www.googleapis.com/drive/v3"}/files/${encodeURIComponent(input.id)}`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", "id,name,mimeType,size,modifiedTime,driveId,parents,trashed,appProperties,sha256Checksum,capabilities(canTrash)");
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Drive object lookup failed with ${response.status}`);
  const metadata = await response.json<ObjectMetadata>();
  if (metadata.id !== input.id || metadata.driveId !== env.TEAM_DRIVE_ID || !metadata.parents?.includes(input.parentId) ||
      metadata.appProperties?.publicar_upload_object !== input.operationId || !metadata.capabilities?.canTrash ||
      (!input.allowTrashed && metadata.trashed) ||
      (input.folder && metadata.mimeType !== "application/vnd.google-apps.folder")) throw new Error("drive_object_mismatch");
  return metadata;
}

export async function createTrackedFolder(env: Env, token: string, input: { id: string; parentId: string; operationId: string; name: string }): Promise<void> {
  try {
    const folder = await createDriveFolder(env, token, input.name, input.parentId, { id: input.id, operationId: input.operationId });
    if (folder.id !== input.id) throw new Error("drive_object_mismatch");
  } catch (error) {
    if (!(error instanceof Error && /^Drive folder create failed with 409\b/.test(error.message))) throw error;
    await verifyDriveObject(env, token, { ...input, folder: true });
  }
}

export async function createTrackedFile(env: Env, token: string, input: {
  id: string; parentId: string; operationId: string; path: string; mimeType: string; body: ArrayBuffer; contentHash: string;
}): Promise<DriveFile> {
  try {
    const file = await uploadDriveFile(env, token, { createId: input.id, parentId: input.parentId, uploadObjectId: input.operationId,
      name: input.path.split("/").pop()!, mimeType: input.mimeType, body: input.body });
    if (file.id !== input.id) throw new Error("drive_object_mismatch");
    return file;
  } catch (error) {
    if (!(error instanceof Error && /^Drive file upload failed with 409\b/.test(error.message))) throw error;
    const metadata = await verifyDriveObject(env, token, input);
    if (metadata.size !== String(input.body.byteLength) || metadata.mimeType !== input.mimeType) throw new Error("drive_object_mismatch");
    let hash: string;
    if (metadata.sha256Checksum && /^[0-9a-f]{64}$/i.test(metadata.sha256Checksum)) {
      hash = bytesToBase64Url(Uint8Array.from(metadata.sha256Checksum.match(/../g)!, byte => parseInt(byte, 16)));
    } else {
      const url = new URL(`${env.GOOGLE_DRIVE_API_BASE_URL ?? "https://www.googleapis.com/drive/v3"}/files/${encodeURIComponent(input.id)}`);
      url.searchParams.set("alt", "media");
      url.searchParams.set("supportsAllDrives", "true");
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`Drive object download failed with ${response.status}`);
      const body = await boundedUploadBody(new Request(url, { method: "POST", body: response.body, headers: response.headers }), input.body.byteLength, true);
      if (body.byteLength !== input.body.byteLength) throw new Error("drive_object_mismatch");
      hash = bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
    }
    if (hash !== input.contentHash) throw new Error("drive_object_mismatch");
    return metadata;
  }
}
