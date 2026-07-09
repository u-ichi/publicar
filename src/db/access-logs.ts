import type { Env } from "../env";
import { randomId } from "../lib/id";
import { clampPageLimit, formatTimeIdCursor, parseTimeIdCursor } from "./pagination";

export type AccessLog = {
  id: string;
  projectId: string;
  userId: string | null;
  userEmail: string | null;
  userName: string | null;
  userAvatarUrl: string | null;
  path: string;
  accessedAt: string;
};

type AccessLogRow = {
  id: string;
  project_id: string;
  user_id: string | null;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  path: string;
  accessed_at: string;
};

function rowToAccessLog(row: AccessLogRow): AccessLog {
  return {
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id,
    userEmail: row.email,
    userName: row.name,
    userAvatarUrl: row.avatar_url,
    path: row.path,
    accessedAt: row.accessed_at
  };
}

async function insertAccessLog(
  env: Env,
  input: { projectId: string; userId: string; path: string }
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO access_logs (id, project_id, user_id, path) VALUES (?, ?, ?, ?)"
  )
    .bind(randomId("alog"), input.projectId, input.userId, input.path)
    .run();
}

async function hasRecentLog(
  env: Env,
  projectId: string,
  userId: string,
  path: string,
  withinSeconds: number
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM access_logs
     WHERE project_id = ? AND user_id = ? AND path = ?
       AND accessed_at > datetime('now', '-' || ? || ' seconds')
     LIMIT 1`
  )
    .bind(projectId, userId, path, withinSeconds)
    .first();
  return row !== null;
}

export async function recordAccessLog(
  env: Env,
  projectId: string,
  userId: string,
  path: string
): Promise<void> {
  if (await hasRecentLog(env, projectId, userId, path, 60)) {
    return;
  }
  await insertAccessLog(env, { projectId, userId, path });
}

export async function listAccessLogs(
  env: Env,
  projectId: string,
  opts: { limit: number; cursor?: string }
): Promise<{ logs: AccessLog[]; nextCursor: string | null }> {
  const limit = clampPageLimit(opts.limit);
  const params: unknown[] = [projectId];
  let sql = `SELECT a.id, a.project_id, a.user_id, u.email, u.name, u.avatar_url, a.path, a.accessed_at
     FROM access_logs a
     LEFT JOIN users u ON a.user_id = u.id
     WHERE a.project_id = ?`;
  const cursor = parseTimeIdCursor(opts.cursor);
  if (cursor) {
    sql += " AND (a.accessed_at < ? OR (a.accessed_at = ? AND a.id < ?))";
    params.push(cursor.time, cursor.time, cursor.id);
  }
  sql += " ORDER BY a.accessed_at DESC, a.id DESC LIMIT ?";
  params.push(limit + 1);

  const result = await env.DB.prepare(sql)
    .bind(...params)
    .all<AccessLogRow>();

  const hasMore = result.results.length > limit;
  const logs = result.results.slice(0, limit).map(rowToAccessLog);
  const lastLog = logs[logs.length - 1];
  const nextCursor = hasMore && lastLog ? formatTimeIdCursor(lastLog.accessedAt, lastLog.id) : null;
  return { logs, nextCursor };
}

export async function deleteOldAccessLogs(env: Env, olderThanDays: number): Promise<number> {
  const result = await env.DB.prepare(
    "DELETE FROM access_logs WHERE accessed_at < datetime('now', '-' || ? || ' days')"
  )
    .bind(olderThanDays)
    .run();
  return result.meta.changes;
}
