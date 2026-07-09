import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { downloadDriveFile } from "../storage/drive";
import { getValidAccessToken } from "./token-refresh";
import { downloadDriveFileWithRetry, withDriveAuthRetry } from "./drive-retry";

vi.mock("./token-refresh", () => ({
  getValidAccessToken: vi.fn()
}));

vi.mock("../storage/drive", () => ({
  downloadDriveFile: vi.fn()
}));

const env = {} as Env;
const getValidAccessTokenMock = vi.mocked(getValidAccessToken);
const downloadDriveFileMock = vi.mocked(downloadDriveFile);

function driveResult(status: number): Awaited<ReturnType<typeof downloadDriveFile>> {
  return {
    status,
    contentType: status === 200 ? "text/html" : null,
    body: new ArrayBuffer(0)
  };
}

describe("withDriveAuthRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getValidAccessTokenMock.mockImplementation(async (_env, _userId, forceRefresh) => forceRefresh ? "fresh-token" : "access-token");
  });

  it("returns the first attempt result without refresh", async () => {
    const fn = vi.fn(async () => "ok");

    await expect(withDriveAuthRetry(env, "user_1", fn)).resolves.toBe("ok");

    expect(fn).toHaveBeenCalledWith("access-token");
    expect(getValidAccessTokenMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes once after a 401 error and returns the retry result", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("Drive file upload failed with 401"))
      .mockResolvedValueOnce("ok");

    await expect(withDriveAuthRetry(env, "user_1", fn)).resolves.toBe("ok");

    expect(fn).toHaveBeenNthCalledWith(1, "access-token");
    expect(fn).toHaveBeenNthCalledWith(2, "fresh-token");
    expect(getValidAccessTokenMock).toHaveBeenNthCalledWith(2, env, "user_1", true);
  });

  it("throws the retry error when the refreshed attempt also fails with 401", async () => {
    const retryError = new Error("Drive file upload failed with 401 again");
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("Drive file upload failed with 401"))
      .mockRejectedValueOnce(retryError);

    await expect(withDriveAuthRetry(env, "user_1", fn)).rejects.toBe(retryError);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(getValidAccessTokenMock).toHaveBeenCalledTimes(2);
  });

  it("throws non-401 errors without refresh", async () => {
    const error = new Error("Drive file upload failed with 403");
    const fn = vi.fn().mockRejectedValueOnce(error);

    await expect(withDriveAuthRetry(env, "user_1", fn)).rejects.toBe(error);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(getValidAccessTokenMock).toHaveBeenCalledTimes(1);
  });

  it("uses initialAccessToken on the first attempt", async () => {
    const fn = vi.fn(async () => "ok");

    await expect(withDriveAuthRetry(env, "user_1", fn, { initialAccessToken: "existing-token" })).resolves.toBe("ok");

    expect(fn).toHaveBeenCalledWith("existing-token");
    expect(getValidAccessTokenMock).not.toHaveBeenCalled();
  });

  it("refreshes from user tokens after an initialAccessToken 401", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("Drive file upload failed with 401"))
      .mockResolvedValueOnce("ok");

    await expect(withDriveAuthRetry(env, "user_1", fn, { initialAccessToken: "existing-token" })).resolves.toBe("ok");

    expect(fn).toHaveBeenNthCalledWith(1, "existing-token");
    expect(fn).toHaveBeenNthCalledWith(2, "fresh-token");
    expect(getValidAccessTokenMock).toHaveBeenCalledOnce();
    expect(getValidAccessTokenMock).toHaveBeenCalledWith(env, "user_1", true);
  });

  it("ignores an initial 404 when requested", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("Drive file trash failed with 404"));

    await expect(withDriveAuthRetry(env, "user_1", fn, { ignoreTrash404OnFirstAttempt: true })).resolves.toBeUndefined();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(getValidAccessTokenMock).toHaveBeenCalledTimes(1);
  });

  it("throws an initial 404 when ignoreTrash404OnFirstAttempt is not set", async () => {
    const error = new Error("Drive file trash failed with 404");
    const fn = vi.fn().mockRejectedValueOnce(error);

    await expect(withDriveAuthRetry(env, "user_1", fn)).rejects.toBe(error);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(getValidAccessTokenMock).toHaveBeenCalledTimes(1);
  });
});

describe("downloadDriveFileWithRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getValidAccessTokenMock.mockImplementation(async (_env, _userId, forceRefresh) => forceRefresh ? "fresh-token" : "access-token");
  });

  it("returns a successful download without refresh", async () => {
    downloadDriveFileMock.mockResolvedValueOnce(driveResult(200));

    await expect(downloadDriveFileWithRetry(env, "user_1", "drive_file")).resolves.toMatchObject({ status: 200 });

    expect(downloadDriveFileMock).toHaveBeenCalledWith(env, "access-token", "drive_file");
    expect(getValidAccessTokenMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes once after a 401 status and returns the retry result", async () => {
    downloadDriveFileMock
      .mockResolvedValueOnce(driveResult(401))
      .mockResolvedValueOnce(driveResult(200));

    await expect(downloadDriveFileWithRetry(env, "user_1", "drive_file")).resolves.toMatchObject({ status: 200 });

    expect(downloadDriveFileMock).toHaveBeenNthCalledWith(1, env, "access-token", "drive_file");
    expect(downloadDriveFileMock).toHaveBeenNthCalledWith(2, env, "fresh-token", "drive_file");
    expect(getValidAccessTokenMock).toHaveBeenNthCalledWith(2, env, "user_1", true);
  });

  it("returns the second 401 status without throwing", async () => {
    downloadDriveFileMock
      .mockResolvedValueOnce(driveResult(401))
      .mockResolvedValueOnce(driveResult(401));

    await expect(downloadDriveFileWithRetry(env, "user_1", "drive_file")).resolves.toMatchObject({ status: 401 });

    expect(downloadDriveFileMock).toHaveBeenCalledTimes(2);
  });

  it("returns 403 and 404 statuses without refresh", async () => {
    downloadDriveFileMock.mockResolvedValueOnce(driveResult(403));
    await expect(downloadDriveFileWithRetry(env, "user_1", "drive_file")).resolves.toMatchObject({ status: 403 });

    vi.clearAllMocks();
    getValidAccessTokenMock.mockResolvedValue("access-token");
    downloadDriveFileMock.mockResolvedValueOnce(driveResult(404));
    await expect(downloadDriveFileWithRetry(env, "user_1", "drive_file")).resolves.toMatchObject({ status: 404 });

    expect(getValidAccessTokenMock).toHaveBeenCalledTimes(1);
  });

  it("returns non-401 failure statuses without refresh", async () => {
    downloadDriveFileMock.mockResolvedValueOnce(driveResult(500));

    await expect(downloadDriveFileWithRetry(env, "user_1", "drive_file")).resolves.toMatchObject({ status: 500 });

    expect(downloadDriveFileMock).toHaveBeenCalledTimes(1);
    expect(getValidAccessTokenMock).toHaveBeenCalledTimes(1);
  });
});
