import type { AuthUser, Env } from "../env";
import { emailDomain, jsonArray } from "../lib/http";
import { randomId } from "../lib/id";

export const VISIBILITIES = ["private", "invite", "domain", "group", "link", "public"] as const;
const RESERVED_ALIASES = new Set(["api", "auth", "health", "p", "favicon.ico", "robots.txt"]);
export type ProjectVisibility = (typeof VISIBILITIES)[number];
export type ProjectRole = "owner" | "editor" | "viewer";

export type ProjectMember = {
  id: string;
  projectId: string;
  userId: string;
  role: ProjectRole;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  createdAt: string;
};

export type Project = {
  id: string;
  alias: string;
  title: string;
  description: string | null;
  createdBy: string;
  visibility: ProjectVisibility;
  allowedDomains: string[];
  allowedGroups: string[];
  entryPath: string;
  driveFolderId: string | null;
  role?: ProjectRole;
  createdAt: string;
  updatedAt: string;
};

type ProjectRow = {
  id: string;
  alias: string;
  title: string;
  description: string | null;
  created_by: string;
  visibility: ProjectVisibility;
  allowed_domains: string;
  allowed_groups: string;
  entry_path: string;
  drive_folder_id: string | null;
  role?: ProjectRole;
  created_at: string;
  updated_at: string;
};

type ProjectMemberRow = {
  id: string;
  project_id: string;
  user_id: string;
  role: ProjectRole;
  email: string;
  name: string | null;
  avatar_url: string | null;
  created_at: string;
};

export function isProjectVisibility(value: unknown): value is ProjectVisibility {
  return typeof value === "string" && VISIBILITIES.includes(value as ProjectVisibility);
}

function parseJsonStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return jsonArray(parsed) ?? [];
}

export function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    alias: row.alias,
    title: row.title,
    description: row.description,
    createdBy: row.created_by,
    visibility: row.visibility,
    allowedDomains: parseJsonStringArray(row.allowed_domains),
    allowedGroups: parseJsonStringArray(row.allowed_groups),
    entryPath: row.entry_path,
    driveFolderId: row.drive_folder_id,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToProjectMember(row: ProjectMemberRow): ProjectMember {
  return {
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id,
    role: row.role,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at
  };
}

export function isValidAlias(alias: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(alias) && !RESERVED_ALIASES.has(alias.toLowerCase());
}

export function normalizeFilePath(path: string): string | null {
  const trimmed = path.trim().replace(/^\.\//, "");
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\\")) {
    return null;
  }
  const parts = trimmed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return null;
  }
  return parts.join("/");
}

export function defaultVisibility(env: Env): ProjectVisibility {
  return isProjectVisibility(env.DEFAULT_VISIBILITY) ? env.DEFAULT_VISIBILITY : "private";
}

function defaultAllowedDomains(env: Env): string[] {
  return (env.ALLOWED_SIGNUP_DOMAINS ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

export function aliasFromTitle(title: string): string {
  const ascii = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (isValidAlias(ascii)) {
    return ascii;
  }
  return `rpt-${crypto.randomUUID().slice(0, 8)}`;
}

export async function listProjectsForUser(env: Env, userId: string): Promise<Project[]> {
  const result = await env.DB.prepare(
    `SELECT p.*, pm.role
     FROM projects p
     JOIN project_members pm ON pm.project_id = p.id
     WHERE pm.user_id = ?
     ORDER BY p.updated_at DESC`
  )
    .bind(userId)
    .all<ProjectRow>();
  return result.results.map(rowToProject);
}

export async function createProject(
  env: Env,
  user: AuthUser,
  input: {
    title: string;
    alias?: string;
    description?: string | null;
    visibility?: ProjectVisibility;
    allowedDomains?: string[];
    allowedGroups?: string[];
    entryPath?: string;
  }
): Promise<Project> {
  const id = randomId("proj");
  const alias = input.alias ?? aliasFromTitle(input.title);
  const visibility = input.visibility ?? defaultVisibility(env);
  const entryPath = normalizeFilePath(input.entryPath ?? "index.html");
  const allowedDomains = input.allowedDomains ?? (visibility === "domain" ? defaultAllowedDomains(env) : []);
  if (!entryPath) {
    throw new Error("Invalid entry_path");
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO projects (
        id, alias, title, description, created_by, visibility,
        allowed_domains, allowed_groups, entry_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      alias,
      input.title,
      input.description ?? null,
      user.id,
      visibility,
      JSON.stringify(allowedDomains),
      JSON.stringify(input.allowedGroups ?? []),
      entryPath
    ),
    env.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role) VALUES (?, ?, ?, 'owner')").bind(
      randomId("pm"),
      id,
      user.id
    )
  ]);
  const project = await getProjectForUser(env, id, user.id);
  if (!project) {
    throw new Error("Failed to create project");
  }
  return project;
}

export async function getProjectForUser(env: Env, id: string, userId: string): Promise<Project | null> {
  const row = await env.DB.prepare(
    `SELECT p.*, pm.role
     FROM projects p
     JOIN project_members pm ON pm.project_id = p.id
     WHERE p.id = ? AND pm.user_id = ?`
  )
    .bind(id, userId)
    .first<ProjectRow>();
  return row ? rowToProject(row) : null;
}

export async function getProjectById(env: Env, id: string): Promise<Project | null> {
  const row = await env.DB.prepare("SELECT p.*, NULL as role FROM projects p WHERE p.id = ?")
    .bind(id)
    .first<ProjectRow>();
  return row ? rowToProject(row) : null;
}

export async function getProjectByAlias(env: Env, alias: string): Promise<Project | null> {
  const row = await env.DB.prepare("SELECT p.*, NULL as role FROM projects p WHERE p.alias = ?")
    .bind(alias)
    .first<ProjectRow>();
  return row ? rowToProject(row) : null;
}

export async function getProjectRole(env: Env, projectId: string, userId: string): Promise<ProjectRole | null> {
  const row = await env.DB.prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?")
    .bind(projectId, userId)
    .first<{ role: ProjectRole }>();
  return row?.role ?? null;
}

export async function listProjectMembers(env: Env, projectId: string): Promise<ProjectMember[]> {
  const result = await env.DB.prepare(
    `SELECT pm.id, pm.project_id, pm.user_id, pm.role, pm.created_at,
      u.email, u.name, u.avatar_url
     FROM project_members pm
     JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = ?
     ORDER BY pm.created_at ASC`
  )
    .bind(projectId)
    .all<ProjectMemberRow>();
  return result.results.map(rowToProjectMember);
}

export async function countProjectOwners(env: Env, projectId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM project_members WHERE project_id = ? AND role = 'owner'")
    .bind(projectId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function upsertProjectMember(
  env: Env,
  input: {
    projectId: string;
    userId: string;
    role: ProjectRole;
  }
): Promise<ProjectMember> {
  const row = await env.DB.prepare(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role
     RETURNING id, project_id, user_id, role, created_at,
      (SELECT email FROM users WHERE users.id = project_members.user_id) AS email,
      (SELECT name FROM users WHERE users.id = project_members.user_id) AS name,
      (SELECT avatar_url FROM users WHERE users.id = project_members.user_id) AS avatar_url`
  )
    .bind(randomId("pm"), input.projectId, input.userId, input.role)
    .first<ProjectMemberRow>();
  if (!row) {
    throw new Error("Failed to upsert project member");
  }
  return rowToProjectMember(row);
}

export async function updateProjectMemberRole(
  env: Env,
  projectId: string,
  userId: string,
  role: ProjectRole
): Promise<ProjectMember | null> {
  const row = await env.DB.prepare(
    `UPDATE project_members SET role = ?
     WHERE project_id = ? AND user_id = ?
     RETURNING id, project_id, user_id, role, created_at,
      (SELECT email FROM users WHERE users.id = project_members.user_id) AS email,
      (SELECT name FROM users WHERE users.id = project_members.user_id) AS name,
      (SELECT avatar_url FROM users WHERE users.id = project_members.user_id) AS avatar_url`
  )
    .bind(role, projectId, userId)
    .first<ProjectMemberRow>();
  return row ? rowToProjectMember(row) : null;
}

export async function deleteProjectMember(env: Env, projectId: string, userId: string): Promise<boolean> {
  const result = await env.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
    .bind(projectId, userId)
    .run();
  return result.meta.changes > 0;
}

export async function updateProject(
  env: Env,
  id: string,
  input: {
    alias?: string;
    title?: string;
    description?: string | null;
    visibility?: ProjectVisibility;
    allowedDomains?: string[];
    allowedGroups?: string[];
    entryPath?: string;
    driveFolderId?: string | null;
  }
): Promise<Project | null> {
  const fields: Array<[string, string | null]> = [];
  if (input.alias !== undefined) fields.push(["alias", input.alias]);
  if (input.title !== undefined) fields.push(["title", input.title]);
  if (input.description !== undefined) fields.push(["description", input.description]);
  if (input.visibility !== undefined) fields.push(["visibility", input.visibility]);
  if (input.allowedDomains !== undefined) fields.push(["allowed_domains", JSON.stringify(input.allowedDomains)]);
  if (input.allowedGroups !== undefined) fields.push(["allowed_groups", JSON.stringify(input.allowedGroups)]);
  if (input.driveFolderId !== undefined) fields.push(["drive_folder_id", input.driveFolderId]);
  if (input.entryPath !== undefined) {
    const path = normalizeFilePath(input.entryPath);
    if (!path) throw new Error("Invalid entry_path");
    fields.push(["entry_path", path]);
  }
  if (!fields.length) return getProjectById(env, id);
  const row = await env.DB.prepare(
    `UPDATE projects SET ${fields.map(([column]) => `${column} = ?`).join(", ")}, updated_at = datetime('now')
     WHERE id = ?
     RETURNING *, NULL as role`
  )
    .bind(
      ...fields.map(([, value]) => value),
      id
    )
    .first<ProjectRow>();
  return row ? rowToProject(row) : null;
}

export async function deleteProject(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();
}

export type DriveAccessRole = "reader" | "commenter" | "writer";

export type ProjectAccess = {
  id: string;
  projectId: string;
  email: string;
  grantedBy: string;
  userId: string | null;
  driveRole: DriveAccessRole | null;
  drivePermissionId: string | null;
  driveError: string | null;
  createdAt: string;
};

type ProjectAccessRow = {
  id: string;
  project_id: string;
  email: string;
  granted_by: string;
  user_id: string | null;
  drive_role: string | null;
  drive_permission_id: string | null;
  drive_error: string | null;
  created_at: string;
};

const PROJECT_ACCESS_SELECT =
  "id, project_id, email, granted_by, user_id, drive_role, drive_permission_id, drive_error, created_at";

function asDriveAccessRole(value: string | null): DriveAccessRole | null {
  if (value === "reader" || value === "commenter" || value === "writer") {
    return value;
  }
  return null;
}

function rowToProjectAccess(row: ProjectAccessRow): ProjectAccess {
  return {
    id: row.id,
    projectId: row.project_id,
    email: row.email,
    grantedBy: row.granted_by,
    userId: row.user_id,
    driveRole: asDriveAccessRole(row.drive_role),
    drivePermissionId: row.drive_permission_id,
    driveError: row.drive_error,
    createdAt: row.created_at
  };
}

export function isValidInviteEmail(email: string): boolean {
  if (email.length < 3 || email.length > 254) {
    return false;
  }
  // API 側の形式検証 (client type=email に依存しない)
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email);
}

export function isDriveAccessRole(value: unknown): value is DriveAccessRole {
  return value === "reader" || value === "commenter" || value === "writer";
}

export async function listProjectAccess(env: Env, projectId: string): Promise<ProjectAccess[]> {
  const result = await env.DB.prepare(
    `SELECT ${PROJECT_ACCESS_SELECT}
     FROM project_access
     WHERE project_id = ?
     ORDER BY created_at ASC`
  )
    .bind(projectId)
    .all<ProjectAccessRow>();
  return result.results.map(rowToProjectAccess);
}

export async function getProjectAccess(
  env: Env,
  projectId: string,
  accessId: string
): Promise<ProjectAccess | null> {
  const row = await env.DB.prepare(
    `SELECT ${PROJECT_ACCESS_SELECT}
     FROM project_access
     WHERE project_id = ? AND id = ?`
  )
    .bind(projectId, accessId)
    .first<ProjectAccessRow>();
  return row ? rowToProjectAccess(row) : null;
}

export async function upsertProjectAccess(
  env: Env,
  input: {
    projectId: string;
    email: string;
    grantedBy: string;
    driveRole?: DriveAccessRole;
  }
): Promise<ProjectAccess> {
  const email = input.email.trim().toLowerCase();
  if (!isValidInviteEmail(email)) {
    throw new Error("Invalid invite email");
  }
  const driveRole = input.driveRole ?? "reader";
  const row = await env.DB.prepare(
    `INSERT INTO project_access (id, project_id, email, granted_by, drive_role)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, email) DO UPDATE SET
       granted_by = excluded.granted_by,
       drive_role = excluded.drive_role
     RETURNING ${PROJECT_ACCESS_SELECT}`
  )
    .bind(randomId("pa"), input.projectId, email, input.grantedBy, driveRole)
    .first<ProjectAccessRow>();
  if (!row) {
    throw new Error("Failed to upsert project access");
  }
  return rowToProjectAccess(row);
}

export async function updateProjectAccessDriveState(
  env: Env,
  accessId: string,
  state: { drivePermissionId: string | null; driveError: string | null }
): Promise<void> {
  await env.DB.prepare(
    `UPDATE project_access SET
      drive_permission_id = ?,
      drive_error = ?
     WHERE id = ?`
  )
    .bind(state.drivePermissionId, state.driveError, accessId)
    .run();
}

export async function deleteProjectAccess(env: Env, projectId: string, accessId: string): Promise<boolean> {
  const result = await env.DB.prepare("DELETE FROM project_access WHERE project_id = ? AND id = ?")
    .bind(projectId, accessId)
    .run();
  return result.meta.changes > 0;
}

/**
 * 招待経路ログイン判定: いずれかの project に有効な招待があるか。
 * 招待は visibility に依らない追加許可なので、visibility での絞り込みはしない
 * (domain 認証の project に社外 1 名を招く用途が主目的)。
 */
export async function hasInviteAccessForLogin(
  env: Env,
  input: { email: string; googleId: string }
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT pa.id
     FROM project_access pa
     WHERE (pa.user_id IS NULL AND lower(pa.email) = lower(?))
        OR pa.user_id = (SELECT id FROM users WHERE google_id = ?)
     LIMIT 1`
  )
    .bind(input.email, input.googleId)
    .first<{ id: string }>();
  return !!row;
}

/**
 * ログイン成功時: lower(email) 一致かつ未 claim の行を user に claim。
 * 同一 (project_id, user_id) が既にあれば未 claim 行を DELETE して統合する。
 */
export async function claimProjectAccessForUser(env: Env, userId: string, email: string): Promise<void> {
  const unclaimed = await env.DB.prepare(
    `SELECT id, project_id FROM project_access
     WHERE user_id IS NULL AND lower(email) = lower(?)`
  )
    .bind(email)
    .all<{ id: string; project_id: string }>();

  for (const row of unclaimed.results) {
    const existing = await env.DB.prepare(
      "SELECT id FROM project_access WHERE project_id = ? AND user_id = ?"
    )
      .bind(row.project_id, userId)
      .first<{ id: string }>();
    if (existing) {
      await env.DB.prepare("DELETE FROM project_access WHERE id = ?").bind(row.id).run();
    } else {
      await env.DB.prepare("UPDATE project_access SET user_id = ? WHERE id = ?")
        .bind(userId, row.id)
        .run();
    }
  }
}

/**
 * 個別招待 (project_access) を持つか。claim 済みは user_id、未 claim 行は email で照合する。
 */
export async function hasProjectAccessGrant(env: Env, projectId: string, user: AuthUser): Promise<boolean> {
  const byUser = await env.DB.prepare("SELECT id FROM project_access WHERE project_id = ? AND user_id = ?")
    .bind(projectId, user.id)
    .first<{ id: string }>();
  if (byUser) {
    return true;
  }
  const byEmail = await env.DB.prepare(
    "SELECT id FROM project_access WHERE project_id = ? AND user_id IS NULL AND lower(email) = lower(?)"
  )
    .bind(projectId, user.email)
    .first<{ id: string }>();
  return !!byEmail;
}

export async function canViewProject(env: Env, project: Project, user: AuthUser | null): Promise<boolean> {
  if (project.visibility === "public" || project.visibility === "link") {
    return true;
  }
  if (!user) {
    return false;
  }
  const role = await getProjectRole(env, project.id, user.id);
  if (role) {
    return true;
  }
  // 個別招待は visibility に依らない追加許可。
  // domain 認証を保ったまま社外コラボレーターを 1 名ずつ足す用途がこれに当たる。
  if (await hasProjectAccessGrant(env, project.id, user)) {
    return true;
  }
  if (project.visibility === "domain") {
    const domain = emailDomain(user.email);
    return !!domain && project.allowedDomains.map((item) => item.toLowerCase()).includes(domain);
  }
  return false;
}

export function canEditProject(role: ProjectRole | null): boolean {
  return role === "owner" || role === "editor";
}

export function canOwnProject(role: ProjectRole | null): boolean {
  return role === "owner";
}
