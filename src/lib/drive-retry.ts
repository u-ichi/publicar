import type { Env } from "../env";
import { downloadDriveFile } from "../storage/drive";
import { getValidAccessToken } from "./token-refresh";
import { getProjectStorage, downloadWithServiceAccount } from "../storage/service-account-drive";
import { withServiceAccount } from "../auth/service-account";
import { assertStorageAccount, verifyServiceAccountLocation } from "../storage/service-account-drive";

type DriveDownloadResult = Awaited<ReturnType<typeof downloadDriveFile>>;

export async function withProjectDriveAuth<T>(env: Env, projectId: string, userId: string, fn: (token: string) => Promise<T>): Promise<T> {
  const storage = await getProjectStorage(env, projectId);
  if (!storage?.storage_service_account) return withDriveAuthRetry(env, userId, fn);
  assertStorageAccount(env, storage.storage_service_account);
  if (!storage.drive_folder_id) throw new Error("project_drive_folder_required");
  return withServiceAccount(env, async (token) => {
    await verifyServiceAccountLocation(env, token, storage.drive_folder_id!);
    return fn(token);
  });
}

export async function downloadProjectFileWithRetry(env: Env, projectId: string, userId: string, fileId: string): Promise<DriveDownloadResult> {
  const storage = await getProjectStorage(env, projectId);
  if (storage?.storage_service_account) {
    if (!storage.drive_folder_id) throw new Error("project_drive_folder_required");
    return downloadWithServiceAccount(env, storage.storage_service_account, storage.drive_folder_id, fileId);
  }
  return downloadDriveFileWithRetry(env, userId, fileId);
}

type DriveRetryOptions = {
  initialAccessToken?: string;
  ignoreTrash404OnFirstAttempt?: boolean;
};

export async function withDriveAuthRetry<T>(
  env: Env,
  userId: string,
  fn: (accessToken: string) => Promise<T>,
  options: DriveRetryOptions = {}
): Promise<T> {
  const token = options.initialAccessToken ?? await getValidAccessToken(env, userId);
  try {
    return await fn(token);
  } catch (error) {
    if (options.ignoreTrash404OnFirstAttempt && error instanceof Error && error.message.includes("404")) {
      return undefined as T;
    }
    if (error instanceof Error && error.message.includes("401")) {
      const refreshedToken = await getValidAccessToken(env, userId, true);
      return fn(refreshedToken);
    }
    throw error;
  }
}

export async function downloadDriveFileWithRetry(env: Env, userId: string, driveFileId: string): Promise<DriveDownloadResult> {
  let accessToken = await getValidAccessToken(env, userId);
  let driveFile = await downloadDriveFile(env, accessToken, driveFileId);
  if (driveFile.status === 401) {
    accessToken = await getValidAccessToken(env, userId, true);
    driveFile = await downloadDriveFile(env, accessToken, driveFileId);
  }
  return driveFile;
}
