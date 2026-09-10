import { Hono, type Context } from "hono";
import { validCommentAnchor } from "../../lib/comment-input";
import {
  addCommentReply,
  canModerateComment,
  createCommentThread,
  deleteCommentThread,
  getCommentThread,
  listCommentThreads,
  listProjectCommentThreads,
  updateCommentThread,
  type CommentActorKind,
  type CommentStatus
} from "../../db/comments";
import { getProjectFile } from "../../db/project-files";
import { canViewProject, getProjectById, getProjectRole, normalizeFilePath } from "../../db/projects";
import { createCommentNotification } from "../../db/notifications";
import type { AppBindings } from "../../env";
import { downloadProjectFileWithRetry } from "../../lib/drive-retry";
import { clampRequestLimit, objectValue, readJsonObject, stringValue } from "../../lib/request";
import { runBackground } from "../../lib/run-background";
import { getCachedFile } from "../../storage/r2";

export const commentsRoute = new Hono<AppBindings>();

function isCommentStatus(value: unknown): value is CommentStatus {
  return value === "open" || value === "resolved";
}

function isCommentActorKind(value: unknown): value is CommentActorKind {
  return value === "human" || value === "ai";
}

function normalizeStatusFilter(value: string | undefined): "open" | "resolved" | "all" {
  return value === "resolved" || value === "all" ? value : "open";
}

async function requireViewableProject(c: Context<AppBindings>, projectId: string) {
  const project = await getProjectById(c.env, projectId);
  if (!project) {
    return { error: c.json({ error: "not_found" }, 404) };
  }
  const user = c.get("user");
  if (!(await canViewProject(c.env, project, user))) {
    return { error: c.json({ error: "not_found" }, 404) };
  }
  return { project, user };
}

function textContentType(contentType: string): boolean {
  return contentType.includes("text/html") || contentType.includes("text/plain") || contentType.includes("application/xhtml+xml");
}

commentsRoute.get("/:id/review-content", async (c) => {
  const projectId = c.req.param("id");
  const viewable = await requireViewableProject(c, projectId);
  if ("error" in viewable) {
    return viewable.error;
  }
  const path = normalizeFilePath(c.req.query("path") ?? viewable.project.entryPath);
  if (!path) {
    return c.json({ error: "invalid_path" }, 400);
  }
  const file = await getProjectFile(c.env, projectId, path);
  if (!file?.driveFileId) {
    return c.json({ error: "not_found" }, 404);
  }
  const cached = await getCachedFile(c.env, file.r2Key);
  if (cached) {
    if (!textContentType(cached.contentType)) {
      return c.json({ error: "unsupported_file_type" }, 415);
    }
    return c.json({
      project: { id: viewable.project.id, title: viewable.project.title, alias: viewable.project.alias },
      file: { path: file.path, contentType: cached.contentType, contentHash: file.contentHash },
      html: new TextDecoder().decode(cached.body)
    });
  }
  const ownerUserId = file.driveOwnerUserId ?? viewable.project.createdBy;
  const driveFile = await downloadProjectFileWithRetry(c.env, projectId, ownerUserId, file.driveFileId);
  if (driveFile.status === 403 || driveFile.status === 404) {
    return c.json({ error: "not_found" }, 404);
  }
  if (driveFile.status !== 200) {
    return c.json({ error: "drive_fetch_failed" }, 502);
  }
  const contentType = driveFile.contentType ?? file.mimeType;
  if (!textContentType(contentType)) {
    return c.json({ error: "unsupported_file_type" }, 415);
  }
  return c.json({
    project: { id: viewable.project.id, title: viewable.project.title, alias: viewable.project.alias },
    file: { path: file.path, contentType, contentHash: file.contentHash },
    html: new TextDecoder().decode(driveFile.body)
  });
});

commentsRoute.get("/:id/comments", async (c) => {
  const projectId = c.req.param("id");
  const viewable = await requireViewableProject(c, projectId);
  if ("error" in viewable) {
    return viewable.error;
  }
  const path = normalizeFilePath(c.req.query("path") ?? viewable.project.entryPath);
  if (!path) {
    return c.json({ error: "invalid_path" }, 400);
  }
  const limit = clampRequestLimit(c.req.query("limit") ?? undefined, 100);
  const { threads, nextCursor } = await listCommentThreads(c.env, projectId, path, {
    status: normalizeStatusFilter(c.req.query("status") ?? undefined),
    limit,
    cursor: c.req.query("cursor") ?? undefined
  });
  return c.json({ threads, nextCursor });
});

commentsRoute.get("/:id/comment-threads", async (c) => {
  const projectId = c.req.param("id");
  const role = await getProjectRole(c.env, projectId, c.get("user").id);
  if (!role) {
    return c.json({ error: "not_found" }, 404);
  }
  const limit = clampRequestLimit(c.req.query("limit") ?? undefined, 50);
  const { threads, nextCursor } = await listProjectCommentThreads(c.env, projectId, {
    status: normalizeStatusFilter(c.req.query("status") ?? "all"),
    limit,
    cursor: c.req.query("cursor") ?? undefined
  });
  return c.json({ threads, nextCursor });
});

commentsRoute.post("/:id/comments", async (c) => {
  const projectId = c.req.param("id");
  const viewable = await requireViewableProject(c, projectId);
  if ("error" in viewable) {
    return viewable.error;
  }
  const body = await readJsonObject(c.req.raw);
  if (!body) {
    return c.json({ error: "invalid_json" }, 400);
  }
  const path = normalizeFilePath(stringValue(body.path) ?? viewable.project.entryPath);
  const commentBody = stringValue(body.body)?.trim();
  const anchor = objectValue(body.anchor);
  const actorKind = body.actorKind === undefined ? "human" : body.actorKind;
  if (!path || !commentBody || commentBody.length > 20000 || !anchor || !validCommentAnchor(anchor) || !isCommentActorKind(actorKind) ||
      [body.selected_text, body.prefix, body.suffix].some((value) => value !== undefined && (typeof value !== "string" || value.length > 10000))) {
    return c.json({ error: "invalid_comment" }, 400);
  }
  const file = await getProjectFile(c.env, projectId, path);
  if (!file) {
    return c.json({ error: "not_found" }, 404);
  }
  const thread = await createCommentThread(c.env, projectId, viewable.user, {
    path,
    body: commentBody,
    anchor,
    selectedText: stringValue(body.selected_text) ?? "",
    prefix: stringValue(body.prefix) ?? "",
    suffix: stringValue(body.suffix) ?? "",
    actorKind,
    clientMutationId: stringValue(body.client_mutation_id) ?? null
  });
  await runBackground(
    c,
    createCommentNotification(c.env, {
      projectId,
      projectTitle: viewable.project.title,
      actor: viewable.user,
      thread
    })
  );
  return c.json({ ok: true, thread }, 201);
});

commentsRoute.post("/:id/comments/:threadId/replies", async (c) => {
  const projectId = c.req.param("id");
  const viewable = await requireViewableProject(c, projectId);
  if ("error" in viewable) {
    return viewable.error;
  }
  const body = await readJsonObject(c.req.raw);
  const replyBody = stringValue(body?.body)?.trim();
  const actorKind = body?.actorKind === undefined ? "human" : body.actorKind;
  if (!replyBody || !isCommentActorKind(actorKind)) {
    return c.json({ error: "invalid_reply" }, 400);
  }
  try {
    const { thread, reply } = await addCommentReply(c.env, projectId, c.req.param("threadId"), viewable.user, replyBody, actorKind);
    await runBackground(
      c,
      createCommentNotification(c.env, {
        projectId,
        projectTitle: viewable.project.title,
        actor: viewable.user,
        thread,
        reply
      })
    );
    return c.json({ ok: true, thread, reply }, 201);
  } catch (error) {
    if (error instanceof Error && error.message === "comment_thread_not_found") {
      return c.json({ error: "not_found" }, 404);
    }
    throw error;
  }
});

commentsRoute.patch("/:id/comments/:threadId", async (c) => {
  const projectId = c.req.param("id");
  const viewable = await requireViewableProject(c, projectId);
  if ("error" in viewable) {
    return viewable.error;
  }
  const thread = await getCommentThread(c.env, projectId, c.req.param("threadId"));
  if (!thread) {
    return c.json({ error: "not_found" }, 404);
  }
  const role = await getProjectRole(c.env, projectId, viewable.user.id);
  if (!canModerateComment(role, viewable.user, thread)) {
    return c.json({ error: "forbidden" }, 403);
  }
  const body = await readJsonObject(c.req.raw);
  if (!body) {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (body.actorKind !== undefined) {
    return c.json({ error: "actor_kind_immutable" }, 400);
  }
  const nextBody = body.body === undefined ? undefined : stringValue(body.body)?.trim();
  const nextStatus = body.status === undefined ? undefined : body.status;
  if ((body.body !== undefined && !nextBody) || (nextStatus !== undefined && !isCommentStatus(nextStatus))) {
    return c.json({ error: "invalid_comment" }, 400);
  }
  const updated = await updateCommentThread(c.env, projectId, thread.id, { body: nextBody, status: nextStatus, actor: viewable.user });
  return c.json({ ok: true, thread: updated });
});

commentsRoute.delete("/:id/comments/:threadId", async (c) => {
  const projectId = c.req.param("id");
  const viewable = await requireViewableProject(c, projectId);
  if ("error" in viewable) {
    return viewable.error;
  }
  const thread = await getCommentThread(c.env, projectId, c.req.param("threadId"));
  if (!thread) {
    return c.json({ error: "not_found" }, 404);
  }
  const role = await getProjectRole(c.env, projectId, viewable.user.id);
  if (!canModerateComment(role, viewable.user, thread)) {
    return c.json({ error: "forbidden" }, 403);
  }
  await deleteCommentThread(c.env, projectId, thread.id);
  return c.json({ ok: true });
});
