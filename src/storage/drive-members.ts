import { DRIVE_SCOPE, serviceAccountConfigured, withServiceAccount } from "../auth/service-account";
import type { Env } from "../env";

// 共有ドライブのメンバー一覧を取り込み、プロジェクトの権限の判定（ビュー project_roles）に使う。
// Google グループは Cloud Identity Groups API で中の人まで展開する。
const GROUPS_SCOPE = "https://www.googleapis.com/auth/cloud-identity.groups.readonly";
const SYNC_INTERVAL_MS = 15 * 60000;

type Permission = { type?: string; emailAddress?: string; domain?: string; deleted?: boolean };
type Membership = { type?: string; preferredMemberKey?: { id?: string } };

export type DriveMemberSync = {
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  source: string | null;
  member_count: number | null;
  domain_count: number | null;
  group_count: number | null;
};

async function googleJson<T>(url: URL, token: string, label: string): Promise<T> {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`${label} failed with ${response.status}`);
  return response.json<T>();
}

async function listPermissions(env: Env, token: string, fileId: string): Promise<Permission[]> {
  const permissions: Permission[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${env.GOOGLE_DRIVE_API_BASE_URL ?? "https://www.googleapis.com/drive/v3"}/files/${encodeURIComponent(fileId)}/permissions`);
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("fields", "nextPageToken,permissions(type,emailAddress,domain,deleted)");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await googleJson<{ permissions?: Permission[]; nextPageToken?: string }>(url, token, "Drive permission list");
    permissions.push(...(page.permissions ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return permissions;
}

async function addGroupMembers(env: Env, token: string, groupEmail: string, emails: Set<string>, visited: Set<string>): Promise<void> {
  if (visited.has(groupEmail)) return;
  visited.add(groupEmail);
  const base = env.CLOUD_IDENTITY_API_BASE_URL ?? "https://cloudidentity.googleapis.com/v1";
  const lookup = new URL(`${base}/groups:lookup`);
  lookup.searchParams.set("groupKey.id", groupEmail);
  const group = await googleJson<{ name?: string }>(lookup, token, "Group lookup");
  if (!group.name || !/^groups\/[A-Za-z0-9_-]+$/.test(group.name)) throw new Error("Group lookup returned an invalid name");
  let pageToken: string | undefined;
  do {
    const url = new URL(`${base}/${group.name}/memberships`);
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await googleJson<{ memberships?: Membership[]; nextPageToken?: string }>(url, token, "Group membership list");
    for (const membership of page.memberships ?? []) {
      const id = membership.preferredMemberKey?.id?.toLowerCase();
      if (!id) continue;
      // グループの中のグループも順にたどる
      if (membership.type === "GROUP") await addGroupMembers(env, token, id, emails, visited);
      else emails.add(id);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
}

export async function syncDriveMembers(env: Env): Promise<void> {
  await env.DB.prepare(`INSERT INTO drive_member_sync (id, last_attempt_at) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at`).bind(new Date().toISOString()).run();
  try {
    const permissions = await withServiceAccount(env, token => listPermissions(env, token, env.TEAM_DRIVE_ID!), DRIVE_SCOPE);
    const emails = new Set<string>();
    const domains = new Set<string>();
    const groups: string[] = [];
    for (const permission of permissions) {
      if (permission.deleted) continue;
      if (permission.type === "user" && permission.emailAddress) emails.add(permission.emailAddress.toLowerCase());
      else if (permission.type === "group" && permission.emailAddress) groups.push(permission.emailAddress.toLowerCase());
      else if (permission.type === "domain" && permission.domain) domains.add(permission.domain.toLowerCase());
    }
    if (groups.length) {
      // 401 で再試行した時に途中の結果を引き継がないよう、展開は試行ごとに最初からやり直す
      const groupMembers = await withServiceAccount(env, async token => {
        const found = new Set<string>();
        const visited = new Set<string>();
        for (const group of groups) await addGroupMembers(env, token, group, found, visited);
        return found;
      }, GROUPS_SCOPE);
      for (const email of groupMembers) emails.add(email);
    }
    // 一覧が空になったら取り込み失敗として扱い、全員が締め出されないよう前回の結果を残す
    if (!emails.size && !domains.size) throw new Error("drive_members_empty");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM drive_member_emails"),
      env.DB.prepare("DELETE FROM drive_member_domains"),
      ...[...emails].map(email => env.DB.prepare("INSERT INTO drive_member_emails (email) VALUES (?)").bind(email)),
      ...[...domains].map(domain => env.DB.prepare("INSERT INTO drive_member_domains (domain) VALUES (?)").bind(domain)),
      env.DB.prepare(`UPDATE drive_member_sync SET last_success_at = ?, last_error = NULL, source = ?, member_count = ?, domain_count = ?, group_count = ?
        WHERE id = 1`).bind(new Date().toISOString(), "shared_drive", emails.size, domains.size, groups.length)
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("drive member sync failed", message);
    await env.DB.prepare("UPDATE drive_member_sync SET last_error = ? WHERE id = 1").bind(message.slice(0, 500)).run();
  }
}

export async function syncDriveMembersIfDue(env: Env): Promise<void> {
  if (!serviceAccountConfigured(env)) return;
  const state = await env.DB.prepare("SELECT last_attempt_at FROM drive_member_sync WHERE id = 1").first<{ last_attempt_at: string | null }>();
  if (state?.last_attempt_at && Date.now() - Date.parse(state.last_attempt_at) < SYNC_INTERVAL_MS) return;
  await syncDriveMembers(env);
}

export async function getDriveMemberSync(env: Env): Promise<DriveMemberSync | null> {
  return env.DB.prepare(`SELECT last_attempt_at, last_success_at, last_error, source, member_count, domain_count, group_count
    FROM drive_member_sync WHERE id = 1`).first<DriveMemberSync>();
}

// 共有ドライブのメンバーとしてプロジェクトの作成と編集ができる利用者か（初回の取り込み前は組織の利用者全員）
export async function isDriveMemberUser(env: Env, userId: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM drive_member_users WHERE user_id = ?").bind(userId).first());
}

export async function isDriveMember(env: Env, email: string): Promise<boolean> {
  const domain = email.slice(email.indexOf("@") + 1).toLowerCase();
  const row = await env.DB.prepare(`SELECT EXISTS (SELECT 1 FROM drive_member_emails WHERE email = ?)
    OR EXISTS (SELECT 1 FROM drive_member_domains WHERE domain = ?) AS included`).bind(email.toLowerCase(), domain).first<{ included: number }>();
  return row?.included === 1;
}
