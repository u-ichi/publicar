import type { Env } from "../env";
import { downloadDriveFile } from "../storage/drive";
import { getValidAccessToken } from "./token-refresh";

type DriveDownloadResult = Awaited<ReturnType<typeof downloadDriveFile>>;

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
