import { Unzip, UnzipInflate } from "fflate";
import { normalizeFilePath } from "../db/projects";
import { UploadInputError } from "./upload-body";

export type ZipEntry = {
  path: string;
  data: Uint8Array;
  mimeType: string;
};

const MIME_MAP: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".md": "text/markdown"
};

function mimeFromPath(path: string): string {
  const extStart = path.lastIndexOf(".");
  if (extStart < 0) {
    return "application/octet-stream";
  }
  const ext = path.slice(extStart).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}

function isOsMetadata(path: string): boolean {
  return (
    path.startsWith("__MACOSX/") ||
    path.endsWith("/.DS_Store") ||
    path === ".DS_Store" ||
    path.endsWith("/Thumbs.db") ||
    path === "Thumbs.db"
  );
}

export function extractZip(buffer: ArrayBuffer, limits = { bytes: 20 * 1024 * 1024, files: 200 }): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const paths = new Set<string>();
  let bytes = 0;
  let count = 0;
  let completed = 0;
  const unzip = new Unzip((file) => {
    count++;
    if (count > limits.files) throw new UploadInputError("too_many_zip_entries", 413);
    const path = normalizeFilePath(file.name.replace(/\/$/, ""));
    if (!path || paths.has(path) || file.name.startsWith("/") || file.name.includes("\\")) throw new UploadInputError("invalid_zip_path");
    paths.add(path);
    if (file.originalSize !== undefined && file.originalSize > limits.bytes - bytes) throw new UploadInputError("expanded_upload_too_large", 413);
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, data, final) => {
      if (error) throw new UploadInputError("invalid_zip");
      bytes += data.byteLength;
      size += data.byteLength;
      if (bytes > limits.bytes) throw new UploadInputError("expanded_upload_too_large", 413);
      chunks.push(data);
      if (final) {
        completed++;
        if (file.name.endsWith("/") || isOsMetadata(path)) return;
        const body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
        entries.push({ path, data: body, mimeType: mimeFromPath(path) });
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  const input = new Uint8Array(buffer);
  // 圧縮データを小分けに渡し、全量を展開する前に上限を判定する。
  try {
    for (let offset = 0; offset < input.length; offset += 4096) unzip.push(input.subarray(offset, offset + 4096), offset + 4096 >= input.length);
  } catch (error) {
    if (error instanceof UploadInputError) throw error;
    throw new UploadInputError("invalid_zip");
  }
  if (completed !== count) throw new UploadInputError("invalid_zip");
  return entries;
}

export function determineEntryPath(entries: ZipEntry[]): string | null {
  const indexHtml = entries.find((entry) => entry.path === "index.html");
  if (indexHtml) {
    return "index.html";
  }

  const htmlFiles = entries.filter((entry) => entry.path.endsWith(".html"));
  if (htmlFiles.length > 0) {
    return htmlFiles[0].path;
  }

  return null;
}
