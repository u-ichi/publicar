import { unzipSync } from "fflate";

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

export function extractZip(buffer: ArrayBuffer): ZipEntry[] {
  const files = unzipSync(new Uint8Array(buffer));
  const entries: ZipEntry[] = [];

  for (const [path, data] of Object.entries(files)) {
    if (path.endsWith("/")) {
      continue;
    }
    if (isOsMetadata(path)) {
      continue;
    }
    entries.push({
      path,
      data,
      mimeType: mimeFromPath(path)
    });
  }
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
