import { env } from "cloudflare:test";
import { vi } from "vitest";
import { createSession } from "../auth/session";
import type { AuthUser, Env } from "../env";
import { encryptToken } from "../lib/crypto";
import initMigration from "../../migrations/0001_init.sql?raw";
import phase2Migration from "../../migrations/0002_phase2_drive.sql?raw";
import cliAuthMigration from "../../migrations/0003_cli_auth.sql?raw";
import accessLogsMigration from "../../migrations/0004_access_logs.sql?raw";
import commentsMigration from "../../migrations/0005_comments.sql?raw";
import commentEventsMigration from "../../migrations/0006_comment_events.sql?raw";
import deployEventsMigration from "../../migrations/0007_deploy_events.sql?raw";
import actorKindMigration from "../../migrations/0008_actor_kind.sql?raw";
import guestAccessMigration from "../../migrations/0009_guest_access.sql?raw";
import accessDriveMigration from "../../migrations/0010_access_drive.sql?raw";
import organizationSecurityMigration from "../../migrations/0011_organization_security.sql?raw";
import serviceAccountMigration from "../../migrations/0012_service_account_uploads.sql?raw";

import uploadBatchesMigration from "../../migrations/0013_upload_batches.sql?raw";

export type { AuthUser, Env };

export function testEnv(overrides: Partial<Env> = {}): Env {
  const workerEnv = env as unknown as Env;
  return {
    DB: workerEnv.DB,
    SESSIONS: workerEnv.SESSIONS,
    CACHE_BUCKET: workerEnv.CACHE_BUCKET,
    DEV_MODE: "true",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    TOKEN_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    SESSION_SECRET: "test-session-secret-with-at-least-32-chars",
    ALLOWED_SIGNUP_DOMAINS: "example.com",
    DEFAULT_VISIBILITY: "private",
    GOOGLE_DRIVE_API_BASE_URL: "https://drive.test/drive/v3",
    GOOGLE_DRIVE_UPLOAD_BASE_URL: "https://drive.test/upload/drive/v3",
    GOOGLE_TOKEN_URL: "https://oauth.test/token",
    SESSION_TTL_SECONDS: "604800",
    OAUTH_STATE_TTL_SECONDS: "600",
    ...overrides
  };
}

export const user: AuthUser = {
  id: "user_1",
  googleId: "google_1",
  email: "user@example.com",
  name: "Test User",
  avatarUrl: null,
  kind: "member"
};

export const editorUser: AuthUser = {
  id: "user_2",
  googleId: "google_2",
  email: "editor@example.com",
  name: "Editor User",
  avatarUrl: null,
  kind: "member"
};

export const guestUser: AuthUser = {
  id: "user_guest",
  googleId: "google_guest",
  email: "guest@gmail.com",
  name: "Guest User",
  avatarUrl: null,
  kind: "guest"
};

export const avatarUser: AuthUser = {
  ...user,
  avatarUrl: "https://example.com/avatar.png"
};

let schemaReady = false;

async function executeMigration(localEnv: Env, sql: string): Promise<void> {
  const statements = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await localEnv.DB.prepare(statement).run();
  }
}

async function ensureSchema(localEnv: Env): Promise<void> {
  if (schemaReady) {
    return;
  }
  await executeMigration(localEnv, initMigration);
  await executeMigration(localEnv, phase2Migration);
  await executeMigration(localEnv, cliAuthMigration);
  await executeMigration(localEnv, accessLogsMigration);
  await executeMigration(localEnv, commentsMigration);
  await executeMigration(localEnv, commentEventsMigration);
  await executeMigration(localEnv, deployEventsMigration);
  await executeMigration(localEnv, actorKindMigration);
  await executeMigration(localEnv, guestAccessMigration);
  await executeMigration(localEnv, accessDriveMigration);
  await executeMigration(localEnv, organizationSecurityMigration);
  await executeMigration(localEnv, serviceAccountMigration);
  await executeMigration(localEnv, uploadBatchesMigration);
  schemaReady = true;
}

export async function resetDatabase(localEnv: Env): Promise<void> {
  await ensureSchema(localEnv);
  await localEnv.DB.prepare("DELETE FROM notification_deliveries").run();
  await localEnv.DB.prepare("DELETE FROM notification_events").run();
  await localEnv.DB.prepare("DELETE FROM deploy_events").run();
  await localEnv.DB.prepare("DELETE FROM project_revisions").run();
  await localEnv.DB.prepare("DELETE FROM upload_objects").run();
  await localEnv.DB.prepare("DELETE FROM drive_cleanup_folders").run();
  await localEnv.DB.prepare("DELETE FROM upload_keys").run();
  await localEnv.DB.prepare("DELETE FROM legacy_storage_operations").run();
  await localEnv.DB.prepare("DELETE FROM comment_events").run();
  await localEnv.DB.prepare("DELETE FROM comment_replies").run();
  await localEnv.DB.prepare("DELETE FROM comment_threads").run();
  await localEnv.DB.prepare("DELETE FROM access_logs").run();
  await localEnv.DB.prepare("DELETE FROM api_keys").run();
  await localEnv.DB.prepare("DELETE FROM automation_grants").run();
  await localEnv.DB.prepare("DELETE FROM security_events").run();
  await localEnv.DB.prepare("DELETE FROM project_files").run();
  await localEnv.DB.prepare("DELETE FROM project_access").run();
  await localEnv.DB.prepare("DELETE FROM project_members").run();
  await localEnv.DB.prepare("DELETE FROM projects").run();
  await localEnv.DB.prepare("DELETE FROM users").run();
  await localEnv.DB.prepare("DELETE FROM oauth_states").run();
  await localEnv.DB.prepare("DELETE FROM cli_auth_states").run();
}

export async function seedUser(
  localEnv: Env,
  seededUser: AuthUser = user,
  overrides: {
    accessToken?: string;
    refreshToken?: string;
    tokenExpiresAt?: number;
  } = {}
): Promise<void> {
  const accessToken = overrides.accessToken ?? "access-token";
  const refreshToken = overrides.refreshToken ?? "refresh-token";
  await localEnv.DB.prepare(
    `INSERT INTO users (
      id, google_id, email, name, avatar_url, kind, encrypted_access_token,
      encrypted_refresh_token, token_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      seededUser.id,
      seededUser.googleId,
      seededUser.email,
      seededUser.name,
      seededUser.avatarUrl,
      seededUser.kind ?? "member",
      await encryptToken(accessToken, localEnv.TOKEN_ENCRYPTION_KEY),
      await encryptToken(refreshToken, localEnv.TOKEN_ENCRYPTION_KEY),
      overrides.tokenExpiresAt ?? Math.floor(Date.now() / 1000) + 3600
    )
    .run();
}

export async function authCookie(localEnv: Env, seededUser: AuthUser = user): Promise<string> {
  await seedUser(localEnv, seededUser);
  return createSession(localEnv, seededUser);
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

export function mockDriveUploads() {
  let uploadCount = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    if (url.pathname === "/drive/v3/files" && init?.method === "POST") {
      return jsonResponse({ id: "drive_folder_zip", name: "zip-site", mimeType: "application/vnd.google-apps.folder" });
    }
    if (url.pathname === "/upload/drive/v3/files" && init?.method === "POST") {
      uploadCount += 1;
      return jsonResponse({
        id: `drive_file_zip_${uploadCount}`,
        name: `file-${uploadCount}`,
        size: "1",
        modifiedTime: "2026-06-19T00:00:00.000Z"
      });
    }
    if (url.pathname.startsWith("/drive/v3/files/") && init?.method === "PATCH") {
      return jsonResponse({ id: url.pathname.split("/").pop(), trashed: true });
    }
    return jsonResponse({ error: "unexpected" }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
