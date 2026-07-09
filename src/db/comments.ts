import type { AuthUser, Env } from "../env";
import { randomId } from "../lib/id";
import { clampPageLimit, formatTimeIdCursor, parseTimeIdCursor } from "./pagination";
import type { ProjectRole } from "./projects";
import type { UserSummary } from "./users";

export type CommentStatus = "open" | "resolved";
export type CommentActorKind = "human" | "ai";

export type CommentAuthor = UserSummary;

export type CommentReply = {
  id: string;
  threadId: string;
  author: CommentAuthor;
  actorKind: CommentActorKind;
  body: string;
  createdAt: string;
};

export type CommentEventKind = "comment_created" | "reply_created" | "status_changed" | "comment_updated" | "current_status";

export type CommentEvent = {
  id: string;
  threadId: string;
  kind: CommentEventKind;
  actor: CommentAuthor;
  body: string;
  previousStatus: CommentStatus | null;
  nextStatus: CommentStatus | null;
  createdAt: string;
  inferred: boolean;
};

export type CommentThread = {
  id: string;
  projectId: string;
  path: string;
  author: CommentAuthor;
  actorKind: CommentActorKind;
  body: string;
  anchor: Record<string, unknown>;
  selectedText: string;
  prefix: string;
  suffix: string;
  status: CommentStatus;
  createdAt: string;
  updatedAt: string;
  replies: CommentReply[];
  events: CommentEvent[];
};

type ThreadRow = {
  id: string;
  project_id: string;
  path: string;
  author_user_id: string;
  author_email: string;
  author_name: string | null;
  author_avatar_url: string | null;
  actor_kind: CommentActorKind;
  body: string;
  anchor_json: string;
  selected_text: string;
  prefix: string;
  suffix: string;
  status: CommentStatus;
  created_at: string;
  updated_at: string;
};

type ReplyRow = {
  id: string;
  thread_id: string;
  author_user_id: string;
  author_email: string;
  author_name: string | null;
  author_avatar_url: string | null;
  actor_kind: CommentActorKind;
  body: string;
  created_at: string;
};

type EventRow = {
  id: string;
  thread_id: string;
  actor_user_id: string;
  actor_email: string;
  actor_name: string | null;
  actor_avatar_url: string | null;
  kind: "status_changed" | "comment_updated";
  previous_status: CommentStatus | null;
  next_status: CommentStatus | null;
  body: string;
  created_at: string;
};

function parseAnchor(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rowToReply(row: ReplyRow): CommentReply {
  return {
    id: row.id,
    threadId: row.thread_id,
    author: {
      id: row.author_user_id,
      email: row.author_email,
      name: row.author_name,
      avatarUrl: row.author_avatar_url
    },
    actorKind: row.actor_kind,
    body: row.body,
    createdAt: row.created_at
  };
}

function rowToEvent(row: EventRow): CommentEvent {
  return {
    id: row.id,
    threadId: row.thread_id,
    kind: row.kind,
    actor: {
      id: row.actor_user_id,
      email: row.actor_email,
      name: row.actor_name,
      avatarUrl: row.actor_avatar_url
    },
    body: row.body,
    previousStatus: row.previous_status,
    nextStatus: row.next_status,
    createdAt: row.created_at,
    inferred: false
  };
}

function rowToThread(row: ThreadRow, replies: CommentReply[] = [], events: CommentEvent[] = []): CommentThread {
  return {
    id: row.id,
    projectId: row.project_id,
    path: row.path,
    author: {
      id: row.author_user_id,
      email: row.author_email,
      name: row.author_name,
      avatarUrl: row.author_avatar_url
    },
    actorKind: row.actor_kind,
    body: row.body,
    anchor: parseAnchor(row.anchor_json),
    selectedText: row.selected_text,
    prefix: row.prefix,
    suffix: row.suffix,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    replies,
    events: sortCommentEvents([
      {
        id: `${row.id}:created`,
        threadId: row.id,
        kind: "comment_created",
        actor: {
          id: row.author_user_id,
          email: row.author_email,
          name: row.author_name,
          avatarUrl: row.author_avatar_url
        },
        body: row.body,
        previousStatus: null,
        nextStatus: "open",
        createdAt: row.created_at,
        inferred: true
      },
      ...replies.map((reply): CommentEvent => ({
        id: `${reply.id}:reply`,
        threadId: row.id,
        kind: "reply_created",
        actor: reply.author,
        body: reply.body,
        previousStatus: null,
        nextStatus: null,
        createdAt: reply.createdAt,
        inferred: true
      })),
      ...events,
      ...(row.status === "resolved" && !events.some((event) => event.kind === "status_changed" && event.nextStatus === "resolved")
        ? [
            {
              id: `${row.id}:current-status`,
              threadId: row.id,
              kind: "current_status" as const,
              actor: {
                id: row.author_user_id,
                email: row.author_email,
                name: row.author_name,
                avatarUrl: row.author_avatar_url
              },
              body: "履歴記録前に解決済みになっています",
              previousStatus: null,
              nextStatus: "resolved" as const,
              createdAt: row.updated_at,
              inferred: true
            }
          ]
        : [])
    ])
  };
}

function sortCommentEvents(events: CommentEvent[]): CommentEvent[] {
  return [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function threadSelect(where: string): string {
  return `SELECT ct.id, ct.project_id, ct.path, ct.author_user_id,
      u.email AS author_email, u.name AS author_name, u.avatar_url AS author_avatar_url,
      ct.actor_kind, ct.body, ct.anchor_json, ct.selected_text, ct.prefix, ct.suffix, ct.status,
      ct.created_at, ct.updated_at
    FROM comment_threads ct
    JOIN users u ON u.id = ct.author_user_id
    WHERE ${where}`;
}

async function listReplies(env: Env, threadIds: string[]): Promise<Map<string, CommentReply[]>> {
  const map = new Map<string, CommentReply[]>();
  if (threadIds.length === 0) {
    return map;
  }
  const placeholders = threadIds.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    `SELECT cr.id, cr.thread_id, cr.author_user_id,
      u.email AS author_email, u.name AS author_name, u.avatar_url AS author_avatar_url,
      cr.actor_kind, cr.body, cr.created_at
     FROM comment_replies cr
     JOIN users u ON u.id = cr.author_user_id
     WHERE cr.deleted_at IS NULL AND cr.thread_id IN (${placeholders})
     ORDER BY cr.created_at ASC`
  )
    .bind(...threadIds)
    .all<ReplyRow>();
  for (const row of result.results) {
    const replies = map.get(row.thread_id) ?? [];
    replies.push(rowToReply(row));
    map.set(row.thread_id, replies);
  }
  return map;
}

async function listEvents(env: Env, threadIds: string[]): Promise<Map<string, CommentEvent[]>> {
  const map = new Map<string, CommentEvent[]>();
  if (threadIds.length === 0) {
    return map;
  }
  const placeholders = threadIds.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    `SELECT ce.id, ce.thread_id, ce.actor_user_id,
      u.email AS actor_email, u.name AS actor_name, u.avatar_url AS actor_avatar_url,
      ce.kind, ce.previous_status, ce.next_status, ce.body, ce.created_at
     FROM comment_events ce
     JOIN users u ON u.id = ce.actor_user_id
     WHERE ce.thread_id IN (${placeholders})
     ORDER BY ce.created_at ASC, ce.id ASC`
  )
    .bind(...threadIds)
    .all<EventRow>();
  for (const row of result.results) {
    const events = map.get(row.thread_id) ?? [];
    events.push(rowToEvent(row));
    map.set(row.thread_id, events);
  }
  return map;
}

export async function listCommentThreads(
  env: Env,
  projectId: string,
  path: string,
  opts: { status?: "open" | "resolved" | "all"; limit: number; cursor?: string }
): Promise<{ threads: CommentThread[]; nextCursor: string | null }> {
  const status = opts.status ?? "open";
  const conditions = ["ct.project_id = ?", "ct.path = ?", "ct.deleted_at IS NULL"];
  const params: unknown[] = [projectId, path];
  if (status !== "all") {
    conditions.push("ct.status = ?");
    params.push(status);
  }
  if (opts.cursor) {
    conditions.push("ct.created_at < ?");
    params.push(opts.cursor);
  }
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const result = await env.DB.prepare(
    `${threadSelect(conditions.join(" AND "))}
     ORDER BY ct.created_at DESC
     LIMIT ?`
  )
    .bind(...params, limit + 1)
    .all<ThreadRow>();
  const rows = result.results.slice(0, limit);
  const threadIds = rows.map((row) => row.id);
  const [replies, events] = await Promise.all([listReplies(env, threadIds), listEvents(env, threadIds)]);
  return {
    threads: rows.map((row) => rowToThread(row, replies.get(row.id) ?? [], events.get(row.id) ?? [])),
    nextCursor: result.results.length > limit ? rows[rows.length - 1]?.created_at ?? null : null
  };
}

export async function listProjectCommentThreads(
  env: Env,
  projectId: string,
  opts: { status?: "open" | "resolved" | "all"; limit: number; cursor?: string }
): Promise<{ threads: CommentThread[]; nextCursor: string | null }> {
  const status = opts.status ?? "all";
  const conditions = [
    "ct.project_id = ?",
    "ct.deleted_at IS NULL",
    "EXISTS (SELECT 1 FROM project_files pf WHERE pf.project_id = ct.project_id AND pf.path = ct.path)"
  ];
  const params: unknown[] = [projectId];
  if (status !== "all") {
    conditions.push("ct.status = ?");
    params.push(status);
  }
  const cursor = parseTimeIdCursor(opts.cursor);
  if (cursor) {
    conditions.push("(ct.updated_at < ? OR (ct.updated_at = ? AND ct.id < ?))");
    params.push(cursor.time, cursor.time, cursor.id);
  }
  const limit = clampPageLimit(opts.limit);
  const result = await env.DB.prepare(
    `${threadSelect(conditions.join(" AND "))}
     ORDER BY ct.updated_at DESC, ct.id DESC
     LIMIT ?`
  )
    .bind(...params, limit + 1)
    .all<ThreadRow>();
  const rows = result.results.slice(0, limit);
  const threadIds = rows.map((row) => row.id);
  const [replies, events] = await Promise.all([listReplies(env, threadIds), listEvents(env, threadIds)]);
  const threads = rows.map((row) => rowToThread(row, replies.get(row.id) ?? [], events.get(row.id) ?? []));
  const lastThread = threads[threads.length - 1];
  return {
    threads,
    nextCursor: result.results.length > limit && lastThread ? formatTimeIdCursor(lastThread.updatedAt, lastThread.id) : null
  };
}

export async function getCommentThread(env: Env, projectId: string, threadId: string): Promise<CommentThread | null> {
  const row = await env.DB.prepare(`${threadSelect("ct.project_id = ? AND ct.id = ? AND ct.deleted_at IS NULL")}`)
    .bind(projectId, threadId)
    .first<ThreadRow>();
  if (!row) {
    return null;
  }
  const [replies, events] = await Promise.all([listReplies(env, [row.id]), listEvents(env, [row.id])]);
  return rowToThread(row, replies.get(row.id) ?? [], events.get(row.id) ?? []);
}

export async function createCommentThread(
  env: Env,
  projectId: string,
  user: AuthUser,
  input: {
    path: string;
    body: string;
    anchor: Record<string, unknown>;
    selectedText?: string;
    prefix?: string;
    suffix?: string;
    actorKind?: CommentActorKind;
    clientMutationId?: string | null;
  }
): Promise<CommentThread> {
  const existing = input.clientMutationId
    ? await env.DB.prepare(`${threadSelect("ct.project_id = ? AND ct.client_mutation_id = ? AND ct.deleted_at IS NULL")}`)
        .bind(projectId, input.clientMutationId)
        .first<ThreadRow>()
    : null;
  if (existing) {
    const [replies, events] = await Promise.all([listReplies(env, [existing.id]), listEvents(env, [existing.id])]);
    return rowToThread(existing, replies.get(existing.id) ?? [], events.get(existing.id) ?? []);
  }
  const id = randomId("cmt");
  await env.DB.prepare(
    `INSERT INTO comment_threads (
      id, project_id, path, author_user_id, body, anchor_json,
      selected_text, prefix, suffix, actor_kind, client_mutation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      projectId,
      input.path,
      user.id,
      input.body,
      JSON.stringify(input.anchor),
      input.selectedText ?? "",
      input.prefix ?? "",
      input.suffix ?? "",
      input.actorKind ?? "human",
      input.clientMutationId ?? null
    )
    .run();
  const created = await getCommentThread(env, projectId, id);
  if (!created) {
    throw new Error("Failed to create comment thread");
  }
  return created;
}

export async function updateCommentThread(
  env: Env,
  projectId: string,
  threadId: string,
  input: { body?: string; status?: CommentStatus; actor?: AuthUser }
): Promise<CommentThread | null> {
  const current = await getCommentThread(env, projectId, threadId);
  if (!current) {
    return null;
  }
  const bodyChanged = input.body !== undefined && input.body !== current.body;
  const statusChanged = input.status !== undefined && input.status !== current.status;
  await env.DB.prepare(
    `UPDATE comment_threads
     SET body = ?, status = ?, updated_at = datetime('now')
     WHERE project_id = ? AND id = ? AND deleted_at IS NULL`
  )
    .bind(input.body ?? current.body, input.status ?? current.status, projectId, threadId)
    .run();
  if (input.actor && (bodyChanged || statusChanged)) {
    await env.DB.batch([
      ...(bodyChanged
        ? [
            env.DB.prepare(
              `INSERT INTO comment_events (id, thread_id, actor_user_id, kind, body)
               VALUES (?, ?, ?, 'comment_updated', ?)`
            ).bind(randomId("cevt"), threadId, input.actor.id, input.body ?? "")
          ]
        : []),
      ...(statusChanged
        ? [
            env.DB.prepare(
              `INSERT INTO comment_events (
                id, thread_id, actor_user_id, kind, previous_status, next_status, body
              ) VALUES (?, ?, ?, 'status_changed', ?, ?, ?)`
            ).bind(randomId("cevt"), threadId, input.actor.id, current.status, input.status ?? current.status, "")
          ]
        : [])
    ]);
  }
  return getCommentThread(env, projectId, threadId);
}

export async function deleteCommentThread(env: Env, projectId: string, threadId: string): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE comment_threads SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE project_id = ? AND id = ? AND deleted_at IS NULL"
  )
    .bind(projectId, threadId)
    .run();
  return result.meta.changes > 0;
}

export async function addCommentReply(
  env: Env,
  projectId: string,
  threadId: string,
  user: AuthUser,
  body: string,
  actorKind: CommentActorKind = "human"
): Promise<{ thread: CommentThread; reply: CommentReply }> {
  const thread = await getCommentThread(env, projectId, threadId);
  if (!thread) {
    throw new Error("comment_thread_not_found");
  }
  const id = randomId("reply");
  await env.DB.prepare("INSERT INTO comment_replies (id, thread_id, author_user_id, body, actor_kind) VALUES (?, ?, ?, ?, ?)")
    .bind(id, threadId, user.id, body, actorKind)
    .run();
  await env.DB.prepare("UPDATE comment_threads SET status = 'open', updated_at = datetime('now') WHERE id = ?").bind(threadId).run();
  const updated = await getCommentThread(env, projectId, threadId);
  const reply = updated?.replies.find((item) => item.id === id);
  if (!updated || !reply) {
    throw new Error("Failed to create comment reply");
  }
  return { thread: updated, reply };
}

export function canModerateComment(role: ProjectRole | null, user: AuthUser, thread: CommentThread): boolean {
  return role === "owner" || role === "editor" || thread.author.id === user.id;
}
