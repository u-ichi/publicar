import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import app from "../index";
import { createProject, updateProject } from "../db/projects";
import { authCookie, resetDatabase, testEnv, user, editorUser, jsonResponse, mockDriveUploads } from "./helpers";
import { upsertProjectFile } from "../db/project-files";
import { serviceEnv, mockServiceDrive, SERVICE_EMAIL } from "./service-account-helpers";

describe("project upload keys", () => {
  beforeEach(async () => resetDatabase(testEnv()));
  afterEach(() => vi.unstubAllGlobals());

  it("checks 93 existing files across requests and issues no key before all are checked", async () => {
    const env = await serviceEnv();
    const cookie = await authCookie(env);
    const project = await createProject(env, user, { title: "Many", alias: "many", visibility: "private" });
    await updateProject(env, project.id, { driveFolderId: "folder_auto" });
    for (let i = 0; i < 93; i++) await upsertProjectFile(env, { projectId: project.id, path: `${i}.html`,
      driveFileId: `legacy-${i}`, driveOwnerUserId: user.id, sizeBytes: 1, contentHash: "old",
      mimeType: "text/html", driveModifiedTime: null, cacheEtag: null });
    const { mock } = mockServiceDrive();
    const body = JSON.stringify({ name: "Actions", expires_at: new Date(Date.now() + 86400000).toISOString() });
    for (let i = 0; i < 93; i++) {
      mock.mockClear();
      const response = await app.fetch(new Request(`http://localhost/api/v1/projects/${project.id}/upload-keys`, {
        method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body
      }), env);
      expect(mock.mock.calls.length).toBeLessThanOrEqual(5);
      expect(response.status).toBe(i === 92 ? 201 : 202);
      if (i < 92) {
        expect(await response.json()).toEqual({ status: "preparing" });
        expect(await env.DB.prepare("SELECT 1 FROM upload_keys").first()).toBeNull();
      }
    }
    expect(await env.DB.prepare("SELECT count(*) AS n FROM upload_keys").first()).toEqual({ n: 1 });
  });

  it("requires a service account and never creates a key backed by the owner's Google tokens", async () => {
    const env = testEnv();
    const cookie = await authCookie(env);
    const project = await createProject(env, user, { title: "Auto", alias: "auto", visibility: "private" });
    await updateProject(env, project.id, { driveFolderId: "folder_auto" });
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const response = await app.fetch(new Request(`http://localhost/api/v1/projects/${project.id}/upload-keys`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ name: "Actions", expires_at: new Date(Date.now() + 86400000).toISOString() })
    }), env);
    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("only lets the owner issue and revoke keys, and never lists the secret or its hash", async () => {
    const env = await serviceEnv();
    const cookie = await authCookie(env);
    const otherCookie = await authCookie(env, editorUser);
    const project = await createProject(env, user, { title: "Auto", alias: "auto", visibility: "private" });
    await updateProject(env, project.id, { driveFolderId: "folder_auto" });
    mockServiceDrive();
    const url = `http://localhost/api/v1/projects/${project.id}/upload-keys`;
    const issue = (Cookie: string) => app.fetch(new Request(url, { method: "POST", headers: { Cookie, "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ name: "Actions", expires_at: new Date(Date.now() + 86400000).toISOString() }) }), env);
    expect((await issue(otherCookie)).status).toBe(403);
    const issued = await issue(cookie);
    expect(issued.status).toBe(201);
    const { key, raw_key } = await issued.json<{ key: { id: string }; raw_key: string }>();
    expect(raw_key).toMatch(/^upl_[A-Za-z0-9_-]{43}$/);
    const list = await app.fetch(new Request(url, { headers: { Cookie: cookie } }), env);
    const text = await list.text();
    expect(text).not.toContain(raw_key);
    expect(text).not.toContain("key_hash");
    expect((await app.fetch(new Request(url, { headers: { Authorization: `Bearer ${raw_key}` } }), env)).status).toBe(403);
    expect((await app.fetch(new Request(`${url}/${key.id}`, { method: "DELETE", headers: { Cookie: cookie, Origin: "https://elsewhere.test" } }), env)).status).toBe(403);
    expect((await app.fetch(new Request(`${url}/${key.id}`, { method: "DELETE", headers: { Cookie: cookie, Origin: "http://localhost" } }), env)).status).toBe(200);
    expect((await app.fetch(new Request(`http://localhost/api/v1/projects/${project.id}/deploy`, { method: "POST", headers: { Authorization: `Bearer ${raw_key}` }, body: "x" }), env)).status).toBe(401);
    const rejected = await env.DB.prepare("SELECT upload_key_id, rejection_reason, service_account FROM security_events WHERE status = 401 AND upload_key_id = ?").bind(key.id).first();
    expect(rejected).toEqual({ upload_key_id: key.id, rejection_reason: "invalid_upload_key", service_account: null });
  });

  it("creates a new project's folder only inside the explicitly configured storage root", async () => {
    const env = await serviceEnv();
    env.GOOGLE_SERVICE_ACCOUNT_ROOT_FOLDER_ID = "folder_root";
    const cookie = await authCookie(env);
    const project = await createProject(env, user, { title: "New", alias: "new-auto", visibility: "private" });
    const { mock } = mockServiceDrive();
    const response = await app.fetch(new Request(`http://localhost/api/v1/projects/${project.id}/upload-keys`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Actions", expires_at: new Date(Date.now() + 86400000).toISOString() })
    }), env);
    expect(response.status).toBe(201);
    const creates = mock.mock.calls.filter(([url, options]) => new URL(String(url)).pathname === "/drive/v3/files" && options?.method === "POST");
    expect(creates).toHaveLength(1);
    expect(JSON.parse(String(creates[0][1]?.body))).toMatchObject({ parents: ["folder_root"] });
    expect(await env.DB.prepare("SELECT drive_folder_id, storage_service_account, storage_transition_id FROM projects WHERE id = ?").bind(project.id).first())
      .toEqual({ drive_folder_id: expect.stringMatching(/^generated_/), storage_service_account: SERVICE_EMAIL, storage_transition_id: null });
  });

  it("does not switch an unrelated manual-upload project just because SA credentials exist", async () => {
    const env = await serviceEnv();
    const cookie = await authCookie(env);
    const project = await createProject(env, user, { title: "Manual", alias: "manual", visibility: "private" });
    await updateProject(env, project.id, { driveFolderId: "folder_auto" });
    const mock = mockDriveUploads();
    const result = await app.fetch(new Request(`http://localhost/api/v1/projects/${project.id}/deploy`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "text/html" }, body: "manual" }), env);
    expect(result.status).toBe(200);
    expect(new Headers(mock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer access-token");
    expect(await env.DB.prepare("SELECT storage_service_account FROM projects WHERE id = ?").bind(project.id).first()).toEqual({ storage_service_account: null });
  });

  it("refuses activation while an older file deletion is running", async () => {
    const env = await serviceEnv();
    const cookie = await authCookie(env);
    const project = await createProject(env, user, { title: "Migration", alias: "migration", visibility: "private" });
    await updateProject(env, project.id, { driveFolderId: "folder_auto" });
    await upsertProjectFile(env, { projectId: project.id, path: "index.html", driveFileId: "legacy-file", driveOwnerUserId: user.id,
      sizeBytes: 1, contentHash: "old", mimeType: "text/html", driveModifiedTime: null, cacheEtag: null });
    let resume!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const deleting = new Promise<void>(resolve => { reached = resolve; });
    const { mock } = mockServiceDrive();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Headers(init?.headers).get("Authorization") === "Bearer access-token" && init?.method === "PATCH") {
        reached(); await paused; return jsonResponse({ id: "legacy-file", trashed: true });
      }
      return mock(input, init);
    });
    const removing = app.fetch(new Request(`http://localhost/api/v1/projects/${project.id}/files?path=index.html`, { method: "DELETE", headers: { Cookie: cookie } }), env);
    await deleting;
    const issue = () => app.fetch(new Request(`http://localhost/api/v1/projects/${project.id}/upload-keys`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Actions", expires_at: new Date(Date.now() + 86400000).toISOString() })
    }), env);
    expect((await issue()).status).toBe(409);
    expect(mock).not.toHaveBeenCalled();
    resume();
    expect((await removing).status).toBe(200);
    expect((await issue()).status).toBe(201);
  });

  it("does not issue a key if its owner loses authority during Google checks", async () => {
    const env = await serviceEnv();
    const cookie = await authCookie(env);
    const project = await createProject(env, user, { title: "Owner", alias: "owner", visibility: "private" });
    await updateProject(env, project.id, { driveFolderId: "folder_auto" });
    mockServiceDrive({ onMetadata: async () => { await env.DB.prepare("UPDATE users SET disabled_at = datetime('now') WHERE id = ?").bind(user.id).run(); } });
    const result = await app.fetch(new Request(`http://localhost/api/v1/projects/${project.id}/upload-keys`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Actions", expires_at: new Date(Date.now() + 86400000).toISOString() }) }), env);
    expect(result.status).toBe(409);
    expect(await env.DB.prepare("SELECT 1 FROM upload_keys").first()).toBeNull();
    expect(await env.DB.prepare("SELECT storage_service_account, storage_transition_id FROM projects WHERE id = ?").bind(project.id).first()).toEqual({ storage_service_account: null, storage_transition_id: null });
  });
  it("resumes after a transient check failure and restarts after the preparation expires", async () => {
    const env = await serviceEnv();
    const cookie = await authCookie(env);
    const project = await createProject(env, user, { title: "Resume", alias: "resume", visibility: "private" });
    await updateProject(env, project.id, { driveFolderId: "folder_auto" });
    for (let i = 0; i < 3; i++) await upsertProjectFile(env, { projectId: project.id, path: `${i}.html`, driveFileId: `existing-${i}`,
      driveOwnerUserId: user.id, sizeBytes: 1, contentHash: "old", mimeType: "text/html", driveModifiedTime: null, cacheEtag: null });
    const body = JSON.stringify({ name: "Actions", expires_at: new Date(Date.now() + 86400000).toISOString() });
    const issue = () => app.fetch(new Request(`http://localhost/api/v1/projects/${project.id}/upload-keys`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body
    }), env);
    mockServiceDrive();
    expect((await issue()).status).toBe(202);
    const before = await env.DB.prepare("SELECT storage_transition_id, storage_preparation_after_id FROM projects").first();
    mockServiceDrive({ onMetadata: async () => { throw new Error("Drive location lookup failed with 503"); } });
    expect((await issue()).status).toBe(502);
    expect(await env.DB.prepare("SELECT storage_transition_id, storage_preparation_after_id FROM projects").first()).toEqual(before);
    mockServiceDrive();
    expect((await issue()).status).toBe(202);
    await env.DB.prepare("UPDATE projects SET storage_transition_until = 1").run();
    expect((await issue()).status).toBe(202);
    const restarted = await env.DB.prepare("SELECT storage_transition_id, storage_preparation_after_id FROM projects").first();
    expect(restarted?.storage_transition_id).not.toBe(before?.storage_transition_id);
    expect(restarted?.storage_preparation_after_id).toBe(before?.storage_preparation_after_id);
    expect((await issue()).status).toBe(202);
    expect((await issue()).status).toBe(201);
  });

});
