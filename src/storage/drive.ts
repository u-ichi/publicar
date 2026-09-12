import type { Env } from "../env";

const DRIVE_API_BASE_URL = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_BASE_URL = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

export type DriveFile = {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  trashed?: boolean;
};

function apiBase(env: Env): string {
  return env.GOOGLE_DRIVE_API_BASE_URL ?? DRIVE_API_BASE_URL;
}

function uploadBase(env: Env): string {
  return env.GOOGLE_DRIVE_UPLOAD_BASE_URL ?? DRIVE_UPLOAD_BASE_URL;
}

function driveHeaders(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` };
}

async function ensureDriveResponse(response: Response, label: string): Promise<void> {
  if (!response.ok) {
    const detail = await response.text();
    const suffix = detail ? `: ${detail.slice(0, 300)}` : "";
    throw new Error(`${label} failed with ${response.status}${suffix}`);
  }
}

function appendSharedDriveParams(url: URL): void {
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", "id,name,mimeType,size,modifiedTime,trashed");
}

function multipartRelatedBody(metadata: unknown, body: ArrayBuffer, mimeType: string): { contentType: string; body: Blob } {
  const boundary = `publicar_${crypto.randomUUID()}`;
  const parts = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    new Blob([body], { type: mimeType }),
    `\r\n--${boundary}--`
  ];
  return {
    contentType: `multipart/related; boundary=${boundary}`,
    body: new Blob(parts)
  };
}

export async function createDriveFolder(env: Env, accessToken: string, name: string, parentId = env.TEAM_DRIVE_ID, creation?: { id: string; operationId: string }): Promise<DriveFile> {
  const url = new URL(`${apiBase(env)}/files`);
  appendSharedDriveParams(url);
  const metadata: Record<string, unknown> = {
    name,
    mimeType: FOLDER_MIME_TYPE
  };
  if (creation) { metadata.id = creation.id; metadata.appProperties = { publicar_upload_object: creation.operationId }; }
  if (parentId) {
    metadata.parents = [parentId];
  }
  const response = await fetch(url, {
    redirect: "manual",
    method: "POST",
    signal: AbortSignal.timeout(60000),
    headers: {
      ...driveHeaders(accessToken),
      "Content-Type": "application/json; charset=UTF-8"
    },
    body: JSON.stringify(metadata)
  });
  await ensureDriveResponse(response, "Drive folder create");
  return response.json<DriveFile>();
}

export async function uploadDriveFile(
  env: Env,
  accessToken: string,
  input: {
    fileId?: string | null;
    createId?: string;
    parentId?: string | null;
    name: string;
    mimeType: string;
    body: ArrayBuffer;
    uploadObjectId?: string;
  }
): Promise<DriveFile> {
  const endpoint = input.fileId ? `${uploadBase(env)}/files/${input.fileId}` : `${uploadBase(env)}/files`;
  const url = new URL(endpoint);
  url.searchParams.set("uploadType", "multipart");
  appendSharedDriveParams(url);
  const metadata: Record<string, unknown> = {
    name: input.name,
    mimeType: input.mimeType
  };
  if (input.createId) metadata.id = input.createId;
  if (input.uploadObjectId) metadata.appProperties = { publicar_upload_object: input.uploadObjectId };
  if (!input.fileId && input.parentId) {
    metadata.parents = [input.parentId];
  }
  const multipart = multipartRelatedBody(metadata, input.body, input.mimeType);
  const response = await fetch(url, {
    redirect: "manual",
    method: input.fileId ? "PATCH" : "POST",
    signal: AbortSignal.timeout(60000),
    headers: {
      ...driveHeaders(accessToken),
      "Content-Type": multipart.contentType
    },
    body: multipart.body
  });
  await ensureDriveResponse(response, "Drive file upload");
  return response.json<DriveFile>();
}

export async function downloadDriveFile(
  env: Env,
  accessToken: string,
  fileId: string
): Promise<{ body: ArrayBuffer; contentType: string | null; status: number }> {
  const metadataUrl = new URL(`${apiBase(env)}/files/${fileId}`);
  appendSharedDriveParams(metadataUrl);
  const metadataResponse = await fetch(metadataUrl, {
    redirect: "manual",
    headers: driveHeaders(accessToken)
  });
  if (!metadataResponse.ok) {
    return { body: new ArrayBuffer(0), contentType: null, status: metadataResponse.status };
  }
  const metadata = await metadataResponse.json<DriveFile>();
  if (metadata.trashed) {
    return { body: new ArrayBuffer(0), contentType: null, status: 404 };
  }

  const url = new URL(`${apiBase(env)}/files/${fileId}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  const response = await fetch(url, {
    redirect: "manual",
    headers: driveHeaders(accessToken)
  });
  if (!response.ok) {
    return { body: new ArrayBuffer(0), contentType: null, status: response.status };
  }
  return {
    body: await response.arrayBuffer(),
    contentType: response.headers.get("Content-Type"),
    status: response.status
  };
}

export async function trashDriveFile(env: Env, accessToken: string, fileId: string): Promise<void> {
  const url = new URL(`${apiBase(env)}/files/${fileId}`);
  appendSharedDriveParams(url);
  const response = await fetch(url, {
    redirect: "manual",
    method: "PATCH",
    signal: AbortSignal.timeout(60000),
    headers: {
      ...driveHeaders(accessToken),
      "Content-Type": "application/json; charset=UTF-8"
    },
    body: JSON.stringify({ trashed: true })
  });
  await ensureDriveResponse(response, "Drive file trash");
}

export type DrivePermissionRole = "reader" | "commenter" | "writer";

export type DrivePermission = {
  id: string;
  emailAddress?: string;
  role?: string;
  type?: string;
};

/** project フォルダへユーザー権限を付与 (通知メールなし) */
export async function createDrivePermission(
  env: Env,
  accessToken: string,
  fileId: string,
  input: { email: string; role: DrivePermissionRole }
): Promise<string> {
  const url = new URL(`${apiBase(env)}/files/${fileId}/permissions`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("sendNotificationEmail", "false");
  url.searchParams.set("fields", "id");
  const response = await fetch(url, {
    redirect: "manual",
    method: "POST",
    headers: {
      ...driveHeaders(accessToken),
      "Content-Type": "application/json; charset=UTF-8"
    },
    body: JSON.stringify({
      type: "user",
      role: input.role,
      emailAddress: input.email
    })
  });
  await ensureDriveResponse(response, "Drive permission create");
  const body = await response.json<{ id: string }>();
  if (!body.id) {
    throw new Error("Drive permission create failed: missing id");
  }
  return body.id;
}

/**
 * 既存 permission の role を更新する。
 * Authorization: drive.file を含む (公式: permissions.update)
 * https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/update
 */
export async function updateDrivePermission(
  env: Env,
  accessToken: string,
  fileId: string,
  permissionId: string,
  role: DrivePermissionRole
): Promise<void> {
  const url = new URL(`${apiBase(env)}/files/${fileId}/permissions/${permissionId}`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", "id,role");
  const response = await fetch(url, {
    redirect: "manual",
    method: "PATCH",
    headers: {
      ...driveHeaders(accessToken),
      "Content-Type": "application/json; charset=UTF-8"
    },
    body: JSON.stringify({ role })
  });
  await ensureDriveResponse(response, "Drive permission update");
}

/** 付与済み permission を削除。既に無い (404) は成功扱い */
export async function deleteDrivePermission(
  env: Env,
  accessToken: string,
  fileId: string,
  permissionId: string
): Promise<void> {
  const url = new URL(`${apiBase(env)}/files/${fileId}/permissions/${permissionId}`);
  url.searchParams.set("supportsAllDrives", "true");
  const response = await fetch(url, {
    redirect: "manual",
    method: "DELETE",
    headers: driveHeaders(accessToken)
  });
  if (response.status === 404) {
    return;
  }
  await ensureDriveResponse(response, "Drive permission delete");
}

export async function listDrivePermissions(
  env: Env,
  accessToken: string,
  fileId: string
): Promise<DrivePermission[]> {
  const url = new URL(`${apiBase(env)}/files/${fileId}/permissions`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", "permissions(id,emailAddress,role,type)");
  const response = await fetch(url, {
    redirect: "manual",
    headers: driveHeaders(accessToken)
  });
  await ensureDriveResponse(response, "Drive permission list");
  const body = await response.json<{ permissions?: DrivePermission[] }>();
  return body.permissions ?? [];
}
