import type { Env } from "../env";
import { randomId } from "../lib/id";

export type LegacyStorageOperation = { id: string; deadline: number };

export async function beginLegacyStorageOperation(env: Env, projectId: string): Promise<LegacyStorageOperation | null> {
  const now = Date.now();
  const operation = { id: randomId("legacy"), deadline: now + 5 * 60000 };
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE projects SET storage_transition_id = NULL, storage_transition_until = NULL WHERE id = ? AND storage_transition_until < ?").bind(projectId, now),
    env.DB.prepare(`INSERT INTO legacy_storage_operations (id, project_id, expires_at) SELECT ?, id, ? FROM projects
      WHERE id = ? AND storage_service_account IS NULL AND storage_transition_id IS NULL`)
      .bind(operation.id, now + 10 * 60000, projectId)
  ]);
  return results[1].meta.changes ? operation : null;
}

export async function assertLegacyStorageOperation(env: Env, operation: LegacyStorageOperation): Promise<void> {
  if (Date.now() > operation.deadline || !(await env.DB.prepare(`SELECT 1 FROM legacy_storage_operations l JOIN projects p ON p.id = l.project_id
    WHERE l.id = ? AND l.expires_at > ? AND p.storage_service_account IS NULL AND p.storage_transition_id IS NULL`).bind(operation.id, Date.now()).first())) {
    throw new Error("project_storage_changed");
  }
}

export async function finishLegacyStorageOperation(env: Env, operation: LegacyStorageOperation): Promise<void> {
  await env.DB.prepare("DELETE FROM legacy_storage_operations WHERE id = ?").bind(operation.id).run();
}
