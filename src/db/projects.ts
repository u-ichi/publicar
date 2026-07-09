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
  const current = await getProjectById(env, id);
  if (!current) {
    return null;
  }
  const entryPath = input.entryPath === undefined ? current.entryPath : normalizeFilePath(input.entryPath);
  if (!entryPath) {
    throw new Error("Invalid entry_path");
  }
  const row = await env.DB.prepare(
    `UPDATE projects SET
      alias = ?,
      title = ?,
      description = ?,
      visibility = ?,
      allowed_domains = ?,
      allowed_groups = ?,
      entry_path = ?,
      drive_folder_id = ?,
      updated_at = datetime('now')
     WHERE id = ?
     RETURNING *, NULL as role`
  )
    .bind(
      input.alias ?? current.alias,
      input.title ?? current.title,
      input.description === undefined ? current.description : input.description,
      input.visibility ?? current.visibility,
      JSON.stringify(input.allowedDomains ?? current.allowedDomains),
      JSON.stringify(input.allowedGroups ?? current.allowedGroups),
      entryPath,
      input.driveFolderId === undefined ? current.driveFolderId : input.driveFolderId,
      id
    )
    .first<ProjectRow>();
  return row ? rowToProject(row) : null;
}

export async function deleteProject(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();
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
  if (project.visibility === "domain") {
    const domain = emailDomain(user.email);
    return !!domain && project.allowedDomains.map((item) => item.toLowerCase()).includes(domain);
  }
  if (project.visibility === "invite") {
    const row = await env.DB.prepare("SELECT id FROM project_access WHERE project_id = ? AND lower(email) = lower(?)")
      .bind(project.id, user.email)
      .first<{ id: string }>();
    return !!row;
  }
  return false;
}

export function canEditProject(role: ProjectRole | null): boolean {
  return role === "owner" || role === "editor";
}

export function canOwnProject(role: ProjectRole | null): boolean {
  return role === "owner";
}
