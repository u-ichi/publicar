import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../index";
import { createProject, updateProject } from "../db/projects";
import { createApiKey } from "../db/api-keys";
import { createUploadKey } from "../db/upload-keys";
import { cleanupUploads, CLEANUP_DELAY_MS } from "../storage/upload-cleanup";
import { sha256Base64Url } from "../lib/crypto";
import { authCookie, resetDatabase, testEnv, user, jsonResponse } from "./helpers";
import { serviceEnv, mockServiceDrive, SERVICE_EMAIL } from "./service-account-helpers";

async function setup() {
  const env = await serviceEnv();
  const cookie = await authCookie(env);
  const project = await createProject(env, user, { title: "Batches", alias: "batches", visibility: "public" });
  await updateProject(env, project.id, { driveFolderId: "folder_auto" });
  await env.DB.prepare("UPDATE projects SET storage_service_account = ? WHERE id = ?").bind(SERVICE_EMAIL, project.id).run();
  const issued = await createUploadKey(env, { projectId: project.id, name: "Actions", createdBy: user.id, expiresAt: new Date(Date.now() + 86400000).toISOString() });
  const send = (stage: string, body?: string, request = "run-1", credential = issued.raw_key) => app.fetch(new Request(
    `http://localhost/api/v1/projects/${project.id}/deploy?stage=${stage}`, {
      method: "POST", headers: { Authorization: `Bearer ${credential}`, "Idempotency-Key": request, "Content-Type": "application/json" }, body
    }), env);
  const manifest = async (contents: Record<string, string>) => JSON.stringify({ files: await Promise.all(Object.entries(contents).map(async ([path, body]) => ({
    path, size_bytes: new TextEncoder().encode(body).byteLength, content_hash: await sha256Base64Url(body)
  }))) });
  return { env, project, issued, send, manifest, cookie };
}

describe("split uploads", () => {
  beforeEach(async () => resetDatabase(testEnv()));
  afterEach(() => vi.unstubAllGlobals());

  it("keeps partial uploads private, resumes them, and publishes exactly once for a disabled issuer", async () => {
    const { env, send, manifest } = await setup();
    const { mock } = mockServiceDrive();
    await env.DB.prepare("UPDATE users SET disabled_at = datetime('now') WHERE id = ?").bind(user.id).run();
    const body = await manifest({ "index.html": "new version", "empty.txt": "" });
    const start = await send("start", body);
    expect(start.status).toBe(201);
    const started = await start.json();
    expect(await (await send("start", body)).json()).toEqual(started);
    expect((await send("file&path=index.html", "new version")).status).toBe(200);
    expect((await send("complete")).status).toBe(409);
    expect(await env.DB.prepare("SELECT 1 FROM project_files").first()).toBeNull();
    expect((await send("file&path=empty.txt", "")).status).toBe(200);
    mock.mockClear();
    expect((await send("file&path=index.html", "new version")).status).toBe(200);
    expect(mock).not.toHaveBeenCalled();
    const completed = await send("complete");
    expect(completed.status).toBe(200);
    expect(await (await send("complete")).json()).toEqual(await completed.json());
    expect(await env.DB.prepare("SELECT count(*) AS n FROM deploy_events").first()).toEqual({ n: 1 });
    expect(await (await app.fetch(new Request("http://localhost/batches/"), env)).text()).toBe("new version");
    expect(mock).not.toHaveBeenCalled();
  });

  it("does not restore expired request IDs after cleanup or reuse an ID for a different manifest", async () => {
    const { env, send, manifest } = await setup();
    mockServiceDrive();
    const body = await manifest({ "index.html": "v1" });
    expect((await send("start", body)).status).toBe(201);
    expect((await send("start", await manifest({ "index.html": "v2" }))).status).toBe(409);
    await env.DB.prepare("UPDATE project_revisions SET expires_at = 1").run();
    for (const stage of ["start", "file&path=index.html", "complete"]) {
      expect((await send(stage, stage === "start" ? body : stage === "complete" ? undefined : "v1")).status).toBe(410);
    }
    expect(await env.DB.prepare("SELECT count(*) AS n FROM project_revisions").first()).toEqual({ n: 1 });
  });
  it("limits cleanup to five objects and never deletes a mismatched Drive object", async () => {
    const { env, send, manifest } = await setup();
    const { mock, files } = mockServiceDrive();
    const contents = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i ? `${i}.html` : "index.html", `body-${i}`]));
    expect((await send("start", await manifest(contents))).status).toBe(201);
    for (const [path, content] of Object.entries(contents)) expect((await send(`file&path=${path}`, content)).status).toBe(200);
    const mismatch = await env.DB.prepare("SELECT drive_file_id FROM upload_objects ORDER BY id LIMIT 1").first<{ drive_file_id: string }>();
    files.get(mismatch!.drive_file_id)!.appProperties = { publicar_upload_object: "unrelated" };
    await env.DB.prepare("UPDATE upload_objects SET created_at = ?").bind(Date.now() - CLEANUP_DELAY_MS - 1000).run();
    await env.DB.prepare("UPDATE project_revisions SET expires_at = 1").run();
    mock.mockClear();
    await cleanupUploads(env);
    const deletions = mock.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(deletions.length).toBeLessThanOrEqual(5);
    expect(deletions.some(([url]) => String(url).includes(mismatch!.drive_file_id))).toBe(false);
    expect(mock.mock.calls.length).toBeLessThanOrEqual(40);
    expect(await env.DB.prepare("SELECT 1 FROM upload_objects WHERE drive_file_id = ?").bind(mismatch!.drive_file_id).first()).not.toBeNull();
    expect((await send("start", await manifest(contents))).status).toBe(410);
  });

  it("recovers after Drive success and R2 failure by checking the same ID after 409", async () => {
    const { env, send, manifest } = await setup();
    const { mock } = mockServiceDrive();
    expect((await send("start", await manifest({ "index.html": "content" }))).status).toBe(201);
    const put = vi.spyOn(env.CACHE_BUCKET, "put").mockRejectedValueOnce(new Error("unavailable"));
    expect((await send("file&path=index.html", "content")).status).toBe(502);
    expect(await env.DB.prepare("SELECT 1 FROM upload_parts").first()).toBeNull();
    put.mockRestore();
    mock.mockClear();
    expect((await send("file&path=index.html", "content")).status).toBe(200);
    expect(mock.mock.calls.some(([url]) => String(url).includes("alt=media"))).toBe(true);
    expect((await send("complete")).status).toBe(200);
  });

  it("rejects a 409 object with the wrong content or operation and does not mark it sent", async () => {
    const { send, env, manifest } = await setup();
    const { files } = mockServiceDrive();
    expect((await send("start", await manifest({ "index.html": "abc" }))).status).toBe(201);
    const object = await env.DB.prepare("SELECT id, drive_file_id FROM upload_objects").first<{ id: string; drive_file_id: string }>();
    files.set(object!.drive_file_id, { body: "xyz", mimeType: "text/html", parents: ["folder_auto"], appProperties: { publicar_upload_object: object!.id } });
    expect((await send("file&path=index.html", "abc")).status).toBe(409);
    files.get(object!.drive_file_id)!.body = "abc";
    files.get(object!.drive_file_id)!.appProperties = { publicar_upload_object: "different" };
    expect((await send("file&path=index.html", "abc")).status).toBe(409);
    expect(await env.DB.prepare("SELECT 1 FROM upload_parts").first()).toBeNull();
  });

  it("rechecks key authority after external calls and rejects other actors' requests", async () => {
    const { env, project, issued, send, manifest } = await setup();
    mockServiceDrive({ onUpload: async () => {
      await env.DB.prepare("UPDATE upload_keys SET revoked_at = datetime('now') WHERE id = ?").bind(issued.key.id).run();
    } });
    expect((await send("start", await manifest({ "index.html": "abc" }))).status).toBe(201);
    const other = await createUploadKey(env, { projectId: project.id, name: "Other", createdBy: user.id, expiresAt: new Date(Date.now() + 86400000).toISOString() });
    expect((await send("complete", undefined, "run-1", other.raw_key)).status).toBe(404);
    expect((await send("file&path=index.html", "abc")).status).toBe(401);
    expect(await env.DB.prepare("SELECT 1 FROM upload_parts").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM project_files").first()).toBeNull();
  });

  it("preserves the newer publication when competing batches finish and handles parallel completion retries", async () => {
    const { env, send, manifest } = await setup();
    mockServiceDrive();
    for (const id of ["first", "second"]) {
      expect((await send("start", await manifest({ "index.html": id }), id)).status).toBe(201);
      expect((await send("file&path=index.html", id, id)).status).toBe(200);
    }
    const completions = await Promise.all([send("complete", undefined, "second"), send("complete", undefined, "second")]);
    expect(completions.map(r => r.status)).toEqual([200, 200]);
    expect(await completions[0].json()).toEqual(await completions[1].json());
    expect((await send("complete", undefined, "first")).status).toBe(409);
    expect(await (await app.fetch(new Request("http://localhost/batches/"), env)).text()).toBe("second");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM deploy_events").first()).toEqual({ n: 1 });
  });

  it("rolls back the entire publication when a later SQL statement fails", async () => {
    const { env, send, manifest } = await setup();
    mockServiceDrive();
    expect((await send("start", await manifest({ "index.html": "abc" }))).status).toBe(201);
    expect((await send("file&path=index.html", "abc")).status).toBe(200);
    await env.DB.prepare("CREATE TRIGGER fail_publish BEFORE INSERT ON deploy_events BEGIN SELECT RAISE(ABORT, 'test failure'); END").run();
    try {
      expect((await send("complete")).status).toBe(502);
      expect(await env.DB.prepare("SELECT active_revision_id FROM projects").first()).toEqual({ active_revision_id: null });
      expect(await env.DB.prepare("SELECT published_at, response_json FROM project_revisions").first()).toEqual({ published_at: null, response_json: null });
      expect(await env.DB.prepare("SELECT 1 FROM project_files").first()).toBeNull();
    } finally { await env.DB.prepare("DROP TRIGGER fail_publish").run(); }
    expect((await send("complete")).status).toBe(200);
  });

  it("rejects invalid manifests before Drive work and bounds SQL for 200 files", async () => {
    const { env, send, manifest } = await setup();
    const { mock } = mockServiceDrive();
    const valid = JSON.parse(await manifest({ "index.html": "a" })).files[0];
    for (const files of [[], [{ ...valid, extra: true }], [{ ...valid, path: "../index.html" }],
      [valid, { ...valid, path: "./index.html" }], [{ ...valid, path: "あ".repeat(171) }], [{ ...valid, content_hash: "bad" }],
      [{ ...valid, size_bytes: -1 }], [{ ...valid, size_bytes: 1.5 }]]) {
      expect((await send("start", JSON.stringify({ files }))).status).toBe(400);
    }
    expect((await send("start", " ".repeat(128 * 1024 + 1))).status).toBe(413);
    expect((await send("start", JSON.stringify({ files: Array.from({ length: 201 }, (_, i) => ({ ...valid, path: `${i}.html` })) }))).status).toBe(413);
    expect(mock).not.toHaveBeenCalled();
    let queries = 0;
    const original = env.DB;
    env.DB = new Proxy(original, { get(target, prop) {
      if (prop === "prepare") return (sql: string) => { queries++; return target.prepare(sql); };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const body = JSON.stringify({ files: Array.from({ length: 200 }, (_, i) => ({ ...valid, path: i ? `${i}.html` : "index.html" })) });
    expect((await send("start", body)).status).toBe(201);
    expect(queries).toBeLessThanOrEqual(50);
    expect(mock.mock.calls.length).toBeLessThanOrEqual(40);
    expect(await original.prepare("SELECT count(*) AS n FROM upload_objects").first()).toEqual({ n: 200 });
  });

  it("checks API-key revocation inside publication and protects a concurrent file deletion", async () => {
    const { env, project, cookie, send, manifest } = await setup();
    mockServiceDrive();
    const api = await createApiKey(env, user.id, { name: "API", scopes: ["deploy"], projectId: project.id });
    const body = await manifest({ "index.html": "abc" });
    expect((await send("start", body, "api", api.rawKey)).status).toBe(201);
    expect((await send("file&path=index.html", "abc", "api", api.rawKey)).status).toBe(200);
    const batch = env.DB.batch.bind(env.DB);
    const publication = vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => {
      await env.DB.prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ?").bind(api.apiKey.id).run();
      return batch(statements);
    });
    expect((await send("complete", undefined, "api", api.rawKey)).status).toBe(403);
    publication.mockRestore();
    expect(await env.DB.prepare("SELECT 1 FROM project_files").first()).toBeNull();
    expect((await send("start", body)).status).toBe(201);
    expect((await send("file&path=index.html", "abc")).status).toBe(200);
    expect((await send("complete")).status).toBe(200);
    expect((await send("start", body, "after")).status).toBe(201);
    expect((await send("file&path=index.html", "abc", "after")).status).toBe(200);
    expect((await app.fetch(new Request(`http://localhost/api/v1/projects/${project.id}/files?path=index.html`, { method: "DELETE", headers: { Cookie: cookie } }), env)).status).toBe(200);
    expect((await send("complete", undefined, "after")).status).toBe(409);
    expect(await env.DB.prepare("SELECT 1 FROM project_files").first()).toBeNull();
  });

  it("accepts the maximum manifest and file size with bounded requests, including token refresh", async () => {
    const { env, send, manifest } = await setup();
    const { mock } = mockServiceDrive();
    let refresh = true;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (refresh && init?.method === "POST" && String(input).includes("/upload/drive/")) {
        refresh = false;
        return jsonResponse({ error: "expired_token" }, 401);
      }
      return mock(input, init);
    });
    let queries = 0;
    const original = env.DB;
    env.DB = new Proxy(original, { get(target, prop) {
      if (prop === "prepare") return (sql: string) => { queries++; return target.prepare(sql); };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const data = "a".repeat(5 * 1024 * 1024);
    const contents = { "index.html": data, ...Object.fromEntries(Array.from({ length: 199 }, (_, i) => [`${i}/${"x".repeat(490)}.txt`, ""])) };
    const body = await manifest(contents);
    queries = 0;
    expect((await send("start", body.padEnd(128 * 1024, " "))).status).toBe(201);
    expect(queries).toBeLessThanOrEqual(50);
    for (const [path, content] of Object.entries(contents)) {
      queries = 0;
      mock.mockClear();
      expect((await send(`file&path=${encodeURIComponent(path)}`, content)).status).toBe(200);
      expect(queries).toBeLessThanOrEqual(50);
      expect(mock.mock.calls.length).toBeLessThanOrEqual(40);
    }
    queries = 0;
    expect((await send("complete")).status).toBe(200);
    expect(queries).toBeLessThanOrEqual(50);
    expect(await original.prepare("SELECT count(*) AS n FROM project_files").first()).toEqual({ n: 200 });
  });

});
