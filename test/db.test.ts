import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import migrationSql from "../migrations/0001_init.sql?raw";
import type { Env } from "../src/env";

const tableNames = [
  "oauth_states",
  "invites",
  "api_keys",
  "project_access",
  "project_files",
  "project_members",
  "projects",
  "users"
];

function db(): D1Database {
  return (env as unknown as Env).DB;
}

async function resetDb(): Promise<void> {
  await db().exec(`PRAGMA foreign_keys = OFF; ${tableNames.map((table) => `DROP TABLE IF EXISTS ${table};`).join(" ")}`);
  await db().exec(migrationSql.replace(/\s+/g, " "));
}

describe("D1 migration", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("creates the Phase 1 tables", async () => {
    const result = await db()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' ORDER BY name")
      .all<{ name: string }>();

    expect(result.results.map((row) => row.name)).toEqual([
      "api_keys",
      "invites",
      "oauth_states",
      "project_access",
      "project_files",
      "project_members",
      "projects",
      "users"
    ]);
  });

  it("enforces JSON, alias, path, unique, and size constraints", async () => {
    await db()
      .prepare("INSERT INTO users (id, google_id, email) VALUES (?, ?, ?)")
      .bind("user_1", "google_1", "owner@example.com")
      .run();

    await expect(
      db()
        .prepare("INSERT INTO projects (id, alias, title, created_by, allowed_domains) VALUES (?, ?, ?, ?, ?)")
        .bind("project_bad_json", "valid-alias", "Project", "user_1", "not-json")
        .run()
    ).rejects.toThrow();

    await expect(
      db()
        .prepare("INSERT INTO projects (id, alias, title, created_by) VALUES (?, ?, ?, ?)")
        .bind("project_bad_alias", "-bad", "Project", "user_1")
        .run()
    ).rejects.toThrow();

    await db()
      .prepare("INSERT INTO projects (id, alias, title, created_by) VALUES (?, ?, ?, ?)")
      .bind("project_1", "valid-alias", "Project", "user_1")
      .run();

    await expect(
      db()
        .prepare("INSERT INTO project_files (id, project_id, path, r2_key, size_bytes) VALUES (?, ?, ?, ?, ?)")
        .bind("file_bad_path", "project_1", "../index.html", "r2/a", 1)
        .run()
    ).rejects.toThrow();

    await expect(
      db()
        .prepare("INSERT INTO project_files (id, project_id, path, r2_key, size_bytes) VALUES (?, ?, ?, ?, ?)")
        .bind("file_bad_size", "project_1", "index.html", "r2/a", -1)
        .run()
    ).rejects.toThrow();

    await db()
      .prepare("INSERT INTO project_files (id, project_id, path, r2_key) VALUES (?, ?, ?, ?)")
      .bind("file_1", "project_1", "index.html", "r2/index")
      .run();

    await expect(
      db()
        .prepare("INSERT INTO project_files (id, project_id, path, r2_key) VALUES (?, ?, ?, ?)")
        .bind("file_2", "project_1", "about.html", "r2/index")
        .run()
    ).rejects.toThrow();
  });
});
