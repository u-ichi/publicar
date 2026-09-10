import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { zipSync } from "fflate";
import app from "../index";
import { createProject, updateProject } from "../db/projects";
import { createUploadKey } from "../db/upload-keys";
import { cleanupUploads, CLEANUP_DELAY_MS } from "../storage/upload-cleanup";
import { authCookie, resetDatabase, testEnv, user } from "./helpers";
import { serviceEnv, mockServiceDrive, SERVICE_EMAIL } from "./service-account-helpers";

describe("service account deployment", () => {
  beforeEach(async () => resetDatabase(testEnv()));
  afterEach(() => vi.unstubAllGlobals());
  async function setup() {
    const env = await serviceEnv();
    await authCookie(env);
    const project = await createProject(env, user, { title: "Auto", alias: "auto", visibility: "public" });
    await updateProject(env, project.id, { driveFolderId: "folder_auto" });
    await env.DB.prepare("UPDATE projects SET storage_service_account = ? WHERE id = ?").bind(SERVICE_EMAIL, project.id).run();
    const issued = await createUploadKey(env, { projectId: project.id, name: "Actions", createdBy: user.id, expiresAt: new Date(Date.now() + 86400000).toISOString() });
    await env.DB.prepare("UPDATE users SET encrypted_access_token = NULL, encrypted_refresh_token = NULL, disabled_at = datetime('now') WHERE id = ?").bind(user.id).run();
    const deploy = (body: string | Uint8Array = "<h1>v1</h1>", id = "run-1", zip = false) => app.fetch(new Request(`http://localhost/api/v1/projects/${project.id}/deploy${zip ? "?name=site.zip" : ""}`, {
      method: "POST", headers: { Authorization: `Bearer ${issued.raw_key}`, "Content-Type": zip ? "application/zip" : "text/html", "Idempotency-Key": id }, body
    }), env);
    return { env, project, issued, deploy };
  }

  it("uploads and refills R2 without a personal Google connection, even after the issuer is disabled", async () => {
    const { env, deploy, project } = await setup();
    mockServiceDrive();
    const result = await deploy();
    expect(result.status).toBe(200);
    const stored = await env.DB.prepare("SELECT r2_key FROM project_files WHERE project_id = ?").bind(project.id).first<{ r2_key: string }>();
    expect(stored).not.toBeNull();
    await env.CACHE_BUCKET.delete(stored!.r2_key);
    const response = await app.fetch(new Request("http://localhost/auto/"), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>v1</h1>");
  });

  it("keeps the published version on partial ZIP failure", async () => {
    const { env, deploy, project } = await setup();
    mockServiceDrive();
    expect((await deploy()).status).toBe(200);
    const before = await env.DB.prepare("SELECT active_revision_id FROM projects WHERE id = ?").bind(project.id).first();
    mockServiceDrive({ failUpload: 2 });
    const zip = zipSync({ "index.html": new TextEncoder().encode("new"), "other.html": new TextEncoder().encode("other") });
    expect((await deploy(zip, "run-2", true)).status).toBe(502);
    expect(await env.DB.prepare("SELECT active_revision_id FROM projects WHERE id = ?").bind(project.id).first()).toEqual(before);
    expect(await (await app.fetch(new Request("http://localhost/auto/"), env)).text()).toBe("<h1>v1</h1>");
  });

  it("does not publish when the key is revoked during the upload", async () => {
    const { env, deploy, project, issued } = await setup();
    mockServiceDrive({ onUpload: async () => { await env.DB.prepare("UPDATE upload_keys SET revoked_at = datetime('now') WHERE id = ?").bind(issued.key.id).run(); } });
    expect((await deploy()).status).toBe(401);
    expect(await env.DB.prepare("SELECT * FROM project_files WHERE project_id = ?").bind(project.id).first()).toBeNull();
  });

  it("returns the original success on retry and rejects a changed request with the same ID", async () => {
    const { env, deploy, project } = await setup();
    mockServiceDrive();
    const first = await deploy();
    expect(first.status).toBe(200);
    expect(await (await deploy()).json()).toEqual(await first.json());
    expect((await deploy("changed")).status).toBe(409);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM deploy_events WHERE project_id = ?").bind(project.id).first<{ n: number }>())?.n).toBe(1);
  });

  it("returns the same result for an omitted path after a later ZIP changes the entry", async () => {
    const { deploy } = await setup();
    mockServiceDrive();
    const first = await deploy();
    expect(first.status).toBe(200);
    const zip = zipSync({ "new.html": new TextEncoder().encode("new entry") });
    expect((await deploy(zip, "new-entry", true)).status).toBe(200);
    const replay = await deploy();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await first.json());
  });

  it("only publishes one concurrent update and preserves a concurrent visibility change", async () => {
    const { env, project, deploy } = await setup();
    let resume!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const uploading = new Promise<void>(resolve => { reached = resolve; });
    mockServiceDrive({ onUpload: async count => { if (count === 1) { reached(); await paused; } } });
    const first = deploy("first", "concurrent-1");
    await uploading;
    await updateProject(env, project.id, { visibility: "private" });
    const second = await deploy("second", "concurrent-2");
    expect(second.status).toBe(200);
    resume();
    expect((await first).status).toBe(409);
    const current = await env.DB.prepare("SELECT visibility, active_revision_id FROM projects WHERE id = ?").bind(project.id).first();
    expect(current).toMatchObject({ visibility: "private", active_revision_id: (await second.json<{ revision_id: string }>()).revision_id });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM deploy_events WHERE project_id = ?").bind(project.id).first<{ n: number }>())?.n).toBe(1);
  });

  it("keeps the starting version when another ZIP changes the entry during Google permission checks", async () => {
    const { env, project, deploy, issued } = await setup();
    let resume!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const checking = new Promise<void>(resolve => { reached = resolve; });
    mockServiceDrive({ onMetadata: async count => { if (count === 1) { reached(); await paused; } } });
    const first = app.fetch(new Request(`http://localhost/api/v1/projects/${project.id}/deploy?path=other.txt`, {
      method: "POST", headers: { Authorization: `Bearer ${issued.raw_key}`, "Idempotency-Key": "old-entry", "Content-Type": "text/plain" }, body: "other"
    }), env);
    await checking;
    const zipped = zipSync({ "new.html": new TextEncoder().encode("new entry") });
    expect((await deploy(zipped, "new-entry", true)).status).toBe(200);
    resume();
    expect((await first).status).toBe(409);
    expect((await env.DB.prepare("SELECT entry_path FROM projects WHERE id = ?").bind(project.id).first<{ entry_path: string }>())?.entry_path).toBe("new.html");
    expect(await (await app.fetch(new Request("http://localhost/auto/"), env)).text()).toBe("new entry");
  });

  it("rolls back the pointer and manifest if recording the success fails", async () => {
    const { env, project, deploy } = await setup();
    mockServiceDrive();
    expect((await deploy()).status).toBe(200);
    const before = await env.DB.prepare("SELECT active_revision_id FROM projects WHERE id = ?").bind(project.id).first();
    await env.DB.prepare("CREATE TRIGGER reject_test_deploy BEFORE INSERT ON deploy_events BEGIN SELECT RAISE(ABORT, 'test audit failure'); END").run();
    try { expect((await deploy("next", "run-next")).status).toBe(502); }
    finally { await env.DB.prepare("DROP TRIGGER reject_test_deploy").run(); }
    expect(await env.DB.prepare("SELECT active_revision_id FROM projects WHERE id = ?").bind(project.id).first()).toEqual(before);
    expect(await (await app.fetch(new Request("http://localhost/auto/"), env)).text()).toBe("<h1>v1</h1>");
  });

  it("keeps the old manifest and history when R2 writing fails", async () => {
    const { env, project, deploy } = await setup();
    mockServiceDrive();
    expect((await deploy()).status).toBe(200);
    const before = await env.DB.prepare("SELECT active_revision_id, entry_path FROM projects WHERE id = ?").bind(project.id).first();
    const bucket = env.CACHE_BUCKET;
    env.CACHE_BUCKET = new Proxy(bucket, { get(target, property) {
      if (property === "put") return async () => { throw new Error("test R2 failure"); };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    try { expect((await deploy("not published", "r2-failure")).status).toBe(502); }
    finally { env.CACHE_BUCKET = bucket; }
    expect(await env.DB.prepare("SELECT active_revision_id, entry_path FROM projects WHERE id = ?").bind(project.id).first()).toEqual(before);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM deploy_events WHERE project_id = ?").bind(project.id).first<{ n: number }>())?.n).toBe(1);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM upload_objects WHERE project_id = ?").bind(project.id).first<{ n: number }>())?.n).toBe(2);
    expect(await (await app.fetch(new Request("http://localhost/auto/"), env)).text()).toBe("<h1>v1</h1>");
  });

  it("rejects every protected operation outside the assigned project's upload", async () => {
    const { env, project, issued } = await setup();
    const { mock } = mockServiceDrive();
    const paths = [
      ["GET", `/api/v1/projects/${project.id}`], ["GET", `/api/v1/projects/${project.id}/review-content`],
      ["GET", `/api/v1/projects/${project.id}/files`], ["GET", `/api/v1/projects/${project.id}/upload-keys`],
      ["POST", `/api/v1/projects/${project.id}/upload-keys`], ["POST", "/api/v1/api-keys"],
      ["PATCH", `/api/v1/projects/${project.id}`], ["POST", `/api/v1/projects/${project.id}/members`],
      ["DELETE", `/api/v1/projects/${project.id}`], ["POST", "/api/v1/projects/another-project/deploy"],
      ["GET", `/projects/${project.id}`], ["GET", "/api/v1/whoami"]
    ];
    for (const [method, path] of paths) {
      expect((await app.fetch(new Request(`http://localhost${path}`, { method, headers: { Authorization: `Bearer ${issued.raw_key}` } }), env)).status).toBe(403);
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it("bounds expanded ZIP data before any Drive upload", async () => {
    const { env, deploy } = await setup();
    env.MAX_EXPANDED_UPLOAD_BYTES = "1024";
    const { mock } = mockServiceDrive();
    const zip = zipSync({ "index.html": new Uint8Array(2048).fill(65) });
    expect((await deploy(zip, "too-large", true)).status).toBe(413);
    expect(mock).not.toHaveBeenCalled();
  });

  it("cleans retired and failed uploads but retains every active file", async () => {
    const { env, project, deploy } = await setup();
    mockServiceDrive();
    expect((await deploy("old", "old")).status).toBe(200);
    expect((await deploy("new", "new")).status).toBe(200);
    await env.DB.prepare("UPDATE upload_objects SET created_at = ?").bind(Date.now() - CLEANUP_DELAY_MS - 1000).run();
    await cleanupUploads(env);
    const rows = await env.DB.prepare("SELECT r2_key FROM upload_objects WHERE project_id = ?").bind(project.id).all();
    expect(rows.results).toHaveLength(1);
    expect(await (await app.fetch(new Request("http://localhost/auto/"), env)).text()).toBe("new");
  });
});
