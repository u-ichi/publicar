import { vi } from "vitest";
import { bytesToBase64 } from "../lib/encoding";
import { jsonResponse, testEnv, type Env } from "./helpers";

export const SERVICE_EMAIL = "upload-test@example.iam.gserviceaccount.com";
let testKey: Promise<CryptoKeyPair> | undefined;
export async function serviceEnv(): Promise<Env> {
  testKey ??= crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
  const pair = await testKey;
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer;
  return testEnv({ TEAM_DRIVE_ID: "drive_team", GOOGLE_SERVICE_ACCOUNT_EMAIL: SERVICE_EMAIL,
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${bytesToBase64(new Uint8Array(pkcs8))}\n-----END PRIVATE KEY-----` });
}

export async function servicePublicKey(): Promise<CryptoKey> {
  await serviceEnv();
  return (await testKey!).publicKey;
}

export function mockServiceDrive(options: { onUpload?: (count: number) => Promise<void>; onMetadata?: (count: number) => Promise<void>; failUpload?: number } = {}) {
  let count = 0;
  let metadataCount = 0;
  const prefix = crypto.randomUUID();
  const files = new Map<string, { body: string; mimeType: string; appProperties?: Record<string, string> }>();
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    if (url.href === "https://oauth2.googleapis.com/token") return jsonResponse({ access_token: "service-access-token", token_type: "Bearer", expires_in: 3600 });
    if (new Headers(init?.headers).get("Authorization") !== "Bearer service-access-token") return jsonResponse({ error: "wrong_actor" }, 401);
    if (url.pathname === "/upload/drive/v3/files" && init?.method === "POST") {
      const uploadNumber = ++count;
      await options.onUpload?.(uploadNumber);
      if (uploadNumber === options.failUpload) return jsonResponse({ error: "test_failure" }, 503);
      const multipart = await (init.body as Blob).text();
      const boundary = multipart.slice(0, multipart.indexOf("\r\n"));
      const parts = multipart.split(boundary);
      const meta = JSON.parse(parts[1].split("\r\n\r\n")[1].trim());
      const content = parts[2].slice(parts[2].indexOf("\r\n\r\n") + 4, -2);
      const id = `service_file_${prefix}_${uploadNumber}`;
      files.set(id, { body: content, mimeType: meta.mimeType, appProperties: meta.appProperties });
      return jsonResponse({ id, name: meta.name, modifiedTime: "2026-09-10T00:00:00Z" });
    }
    if (url.pathname === "/drive/v3/files") {
      if (init?.method === "POST") return jsonResponse({ id: "folder_auto", name: "auto" });
      return jsonResponse({ files: [], nextPageToken: undefined });
    }
    const id = url.pathname.split("/").pop()!;
    if (url.pathname.startsWith("/drive/v3/files/")) {
      if (init?.method === "PATCH") return jsonResponse({ id, trashed: true });
      const file = files.get(id);
      if (url.searchParams.get("alt") === "media") return file ? new Response(file.body, { headers: { "Content-Type": file.mimeType } }) : new Response("", { status: 404 });
      await options.onMetadata?.(++metadataCount);
      return jsonResponse({ id, driveId: "drive_team", parents: ["folder_auto"], mimeType: id === "folder_auto" || id === "folder_root" ? "application/vnd.google-apps.folder" : file?.mimeType ?? "text/html",
        capabilities: { canEdit: true, canAddChildren: true, canDownload: true, canTrash: true } });
    }
    return jsonResponse({ error: "unexpected" }, 500);
  });
  vi.stubGlobal("fetch", mock);
  return { mock, files };
}
