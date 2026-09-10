import type { Env } from "../env";
import { randomId } from "../lib/id";

export type DeployEvent = {
  id: string;
  projectId: string;
  deployerUserId: string | null;
  uploadKeyId: string | null;
  serviceAccount: string | null;
  revisionId: string | null;
  deployType: "file" | "zip";
  path: string | null;
  filesCount: number;
  totalSizeBytes: number;
  contentHash: string | null;
  deployedAt: string;
};

export type DeployEventWithDeployer = DeployEvent & {
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
};

type DeployEventRow = {
  id: string;
  project_id: string;
  deployer_user_id: string | null;
  upload_key_id: string | null;
  service_account: string | null;
  revision_id: string | null;
  deploy_type: "file" | "zip";
  path: string | null;
  files_count: number;
  total_size_bytes: number;
  content_hash: string | null;
  deployed_at: string;
};

type DeployEventWithDeployerRow = DeployEventRow & {
  email: string | null;
  name: string | null;
  avatar_url: string | null;
};

function rowToDeployEvent(row: DeployEventRow): DeployEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    deployerUserId: row.deployer_user_id,
    uploadKeyId: row.upload_key_id,
    serviceAccount: row.service_account,
    revisionId: row.revision_id,
    deployType: row.deploy_type,
    path: row.path,
    filesCount: row.files_count,
    totalSizeBytes: row.total_size_bytes,
    contentHash: row.content_hash,
    deployedAt: row.deployed_at
  };
}

function rowToDeployEventWithDeployer(row: DeployEventWithDeployerRow): DeployEventWithDeployer {
  return {
    ...rowToDeployEvent(row),
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url
  };
}

export async function insertDeployEvent(
  env: Env,
  input: {
    projectId: string;
    deployerUserId: string;
    deployType: "file" | "zip";
    path: string | null;
    filesCount: number;
    totalSizeBytes: number;
    contentHash: string | null;
  }
): Promise<DeployEvent> {
  const row = await env.DB.prepare(
    `INSERT INTO deploy_events (
      id, project_id, deployer_user_id, deploy_type, path,
      files_count, total_size_bytes, content_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *`
  )
    .bind(
      randomId("dep"),
      input.projectId,
      input.deployerUserId,
      input.deployType,
      input.path,
      input.filesCount,
      input.totalSizeBytes,
      input.contentHash
    )
    .first<DeployEventRow>();
  if (!row) {
    throw new Error("Failed to insert deploy event");
  }
  return rowToDeployEvent(row);
}

export async function listDeployEventsWithDeployers(env: Env, projectId: string): Promise<DeployEventWithDeployer[]> {
  const result = await env.DB.prepare(
    `SELECT
      de.*,
      u.email,
      CASE WHEN de.upload_key_id IS NOT NULL THEN '自動アップロード: ' || COALESCE(uk.name, de.upload_key_id) ELSE u.name END AS name,
      u.avatar_url
     FROM deploy_events de
     LEFT JOIN users u ON u.id = de.deployer_user_id
     LEFT JOIN upload_keys uk ON uk.id = de.upload_key_id
     WHERE de.project_id = ?
     ORDER BY de.deployed_at DESC, de.id DESC`
  )
    .bind(projectId)
    .all<DeployEventWithDeployerRow>();
  return result.results.map(rowToDeployEventWithDeployer);
}
