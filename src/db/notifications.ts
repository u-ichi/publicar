import type { AuthUser, Env } from "../env";
import { randomId } from "../lib/id";
import type { CommentReply, CommentThread } from "./comments";
import type { UserSummary } from "./users";

export type NotificationItem = {
  id: string;
  eventId: string;
  projectId: string;
  threadId: string | null;
  replyId: string | null;
  actor: UserSummary;
  kind: "comment_created" | "comment_replied";
  title: string;
  body: string;
  url: string;
  readAt: string | null;
  createdAt: string;
};

type NotificationRow = {
  id: string;
  event_id: string;
  project_id: string;
  thread_id: string | null;
  reply_id: string | null;
  actor_user_id: string;
  actor_email: string;
  actor_name: string | null;
  actor_avatar_url: string | null;
  kind: "comment_created" | "comment_replied";
  title: string;
  body: string;
  url: string;
  read_at: string | null;
  created_at: string;
};

function rowToNotification(row: NotificationRow): NotificationItem {
  return {
    id: row.id,
    eventId: row.event_id,
    projectId: row.project_id,
    threadId: row.thread_id,
    replyId: row.reply_id,
    actor: {
      id: row.actor_user_id,
      email: row.actor_email,
      name: row.actor_name,
      avatarUrl: row.actor_avatar_url
    },
    kind: row.kind,
    title: row.title,
    body: row.body,
    url: row.url,
    readAt: row.read_at,
    createdAt: row.created_at
  };
}

async function ownerRecipients(env: Env, projectId: string, actorUserId: string): Promise<string[]> {
  const result = await env.DB.prepare(
    "SELECT user_id FROM project_members WHERE project_id = ? AND role = 'owner' AND user_id <> ? ORDER BY created_at ASC"
  )
    .bind(projectId, actorUserId)
    .all<{ user_id: string }>();
  return result.results.map((row) => row.user_id);
}

export async function createCommentNotification(
  env: Env,
  input: {
    projectId: string;
    projectTitle: string;
    actor: AuthUser;
    thread: CommentThread;
    reply?: CommentReply;
  }
): Promise<void> {
  const recipients = await ownerRecipients(env, input.projectId, input.actor.id);
  if (recipients.length === 0) {
    return;
  }
  const eventId = randomId("nevt");
  const kind = input.reply ? "comment_replied" : "comment_created";
  const body = input.reply?.body ?? input.thread.body;
  const url = `/projects/${encodeURIComponent(input.projectId)}/review?path=${encodeURIComponent(input.thread.path)}#comment-${encodeURIComponent(input.thread.id)}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO notification_events (
        id, project_id, thread_id, reply_id, actor_user_id, kind, title, body, url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      eventId,
      input.projectId,
      input.thread.id,
      input.reply?.id ?? null,
      input.actor.id,
      kind,
      input.projectTitle,
      body.slice(0, 500),
      url
    ),
    ...recipients.map((recipientId) =>
      env.DB.prepare(
        `INSERT INTO notification_deliveries (
          id, event_id, recipient_user_id, channel, status, delivered_at
        ) VALUES (?, ?, ?, 'app', 'delivered', datetime('now'))`
      ).bind(randomId("ndlv"), eventId, recipientId)
    )
  ]);
}

export async function listNotifications(
  env: Env,
  userId: string,
  opts: { status?: "unread" | "all"; limit: number; cursor?: string }
): Promise<{ notifications: NotificationItem[]; unreadCount: number; nextCursor: string | null }> {
  const conditions = ["nd.recipient_user_id = ?", "nd.channel = 'app'"];
  const params: unknown[] = [userId];
  if ((opts.status ?? "unread") === "unread") {
    conditions.push("nd.read_at IS NULL");
  }
  if (opts.cursor) {
    conditions.push("ne.created_at < ?");
    params.push(opts.cursor);
  }
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const [rowsResult, unreadRow] = await Promise.all([
    env.DB.prepare(
      `SELECT nd.id, nd.event_id, ne.project_id, ne.thread_id, ne.reply_id,
        ne.actor_user_id, u.email AS actor_email, u.name AS actor_name, u.avatar_url AS actor_avatar_url,
        ne.kind, ne.title, ne.body, ne.url, nd.read_at, ne.created_at
       FROM notification_deliveries nd
       JOIN notification_events ne ON ne.id = nd.event_id
       JOIN users u ON u.id = ne.actor_user_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY ne.created_at DESC
       LIMIT ?`
    )
      .bind(...params, limit + 1)
      .all<NotificationRow>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM notification_deliveries WHERE recipient_user_id = ? AND channel = 'app' AND read_at IS NULL"
    )
      .bind(userId)
      .first<{ count: number }>()
  ]);
  const rows = rowsResult.results.slice(0, limit);
  return {
    notifications: rows.map(rowToNotification),
    unreadCount: unreadRow?.count ?? 0,
    nextCursor: rowsResult.results.length > limit ? rows[rows.length - 1]?.created_at ?? null : null
  };
}

export async function markNotificationRead(env: Env, userId: string, id: string): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE notification_deliveries SET read_at = COALESCE(read_at, datetime('now')) WHERE id = ? AND recipient_user_id = ? AND channel = 'app'"
  )
    .bind(id, userId)
    .run();
  return result.meta.changes > 0;
}

export async function markAllNotificationsRead(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE notification_deliveries SET read_at = COALESCE(read_at, datetime('now')) WHERE recipient_user_id = ? AND channel = 'app' AND read_at IS NULL"
  )
    .bind(userId)
    .run();
}
