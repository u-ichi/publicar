import type { Context } from "hono";
import { recordAccessLog } from "../db/access-logs";
import { getProjectFile } from "../db/project-files";
import { canViewProject, getProjectByAlias, normalizeFilePath, type Project } from "../db/projects";
import type { AppBindings } from "../env";
import { downloadProjectFileWithRetry } from "../lib/drive-retry";
import { runBackground } from "../lib/run-background";
import { commentWorkbenchPage } from "./home";
import { deleteCachedFile, getCachedFile, putCachedFile } from "../storage/r2";

const HTML_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: https:; font-src data: https:; connect-src 'none'; worker-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const REVIEW_HTML_CSP = HTML_CSP.replace("sandbox allow-scripts", "sandbox allow-scripts allow-same-origin").replace(
  "frame-ancestors 'none'",
  "frame-ancestors 'self'"
);

function requestPath(c: Context<AppBindings>): string | null {
  const rawPath = c.req.param("path");
  if (!rawPath) {
    return null;
  }
  return normalizeFilePath(rawPath);
}

function contentHeaders(contentType: string, project: Project, options: { reviewFrame?: boolean } = {}): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer"
  };
  if (contentType.includes("text/html")) {
    headers["Content-Security-Policy"] = options.reviewFrame ? REVIEW_HTML_CSP : HTML_CSP;
  }
  if (project.visibility === "link") {
    headers["X-Robots-Tag"] = "noindex, nofollow";
  }
  return headers;
}

function shouldServeCommentWorkbench(c: Context<AppBindings>, contentType: string, options: { reviewFrame: boolean; hasUser: boolean }): boolean {
  return options.hasUser && !options.reviewFrame && c.req.query("__publicar_raw") !== "1" && contentType.includes("text/html");
}

function loginRedirect(c: Context<AppBindings>): Response {
  const login = new URL("/auth/login", c.req.url);
  login.searchParams.set("redirectTo", new URL(c.req.url).pathname);
  return c.redirect(login.toString(), 302);
}

export async function serveProject(c: Context<AppBindings>): Promise<Response> {
  c.header("Cache-Control", "no-store");
  const alias = c.req.param("alias");
  if (!alias) {
    return c.notFound();
  }
  const subPath = requestPath(c);
  if (!subPath) {
    const url = new URL(c.req.url);
    if (!url.pathname.endsWith("/")) {
      url.pathname += "/";
      return c.redirect(url.toString(), 301);
    }
  }
  const project = await getProjectByAlias(c.env, alias);
  if (!project) {
    return c.notFound();
  }
  const user = c.get("user") ?? null;
  if (!(await canViewProject(c.env, project, user))) {
    return user ? c.json({ error: "forbidden" }, 403) : loginRedirect(c);
  }
  const reviewFrame = c.req.query("__publicar_review") === "1" && Boolean(user);
  const path = subPath ?? project.entryPath;
  if (user && !subPath) {
    await runBackground(c, recordAccessLog(c.env, project.id, user.id, path));
  }
  const file = await getProjectFile(c.env, project.id, path);
  if (!file?.driveFileId) {
    return c.notFound();
  }
  const cached = await getCachedFile(c.env, file.r2Key);
  if (cached) {
    if (user && shouldServeCommentWorkbench(c, cached.contentType, { reviewFrame, hasUser: true })) {
      return c.html(commentWorkbenchPage(user, project, path));
    }
    return new Response(cached.body, { headers: contentHeaders(cached.contentType, project, { reviewFrame }) });
  }

  const ownerUserId = file.driveOwnerUserId ?? project.createdBy;
  const driveFile = await downloadProjectFileWithRetry(c.env, project.id, ownerUserId, file.driveFileId);
  if (driveFile.status === 403 || driveFile.status === 404) {
    await deleteCachedFile(c.env, file.r2Key);
    return c.notFound();
  }
  if (driveFile.status !== 200) {
    return c.json({ error: "drive_fetch_failed" }, 502);
  }

  const contentType = driveFile.contentType ?? file.mimeType;
  await putCachedFile(c.env, file.r2Key, driveFile.body, contentType);
  if (user && shouldServeCommentWorkbench(c, contentType, { reviewFrame, hasUser: true })) {
    return c.html(commentWorkbenchPage(user, project, path));
  }
  return new Response(driveFile.body, { headers: contentHeaders(contentType, project, { reviewFrame }) });
}
