import { describe, expect, it } from "vitest";
import { testEnv } from "./helpers";

import migration0 from "../../migrations/0001_init.sql?raw";
import migration1 from "../../migrations/0002_phase2_drive.sql?raw";
import migration2 from "../../migrations/0003_cli_auth.sql?raw";
import migration3 from "../../migrations/0004_access_logs.sql?raw";
import migration4 from "../../migrations/0005_comments.sql?raw";
import migration5 from "../../migrations/0006_comment_events.sql?raw";
import migration6 from "../../migrations/0007_deploy_events.sql?raw";
import migration7 from "../../migrations/0008_actor_kind.sql?raw";
import migration8 from "../../migrations/0009_guest_access.sql?raw";
import migration9 from "../../migrations/0010_access_drive.sql?raw";
import migration10 from "../../migrations/0011_organization_security.sql?raw";

const migrations: Record<string, string> = {
  "0001_init.sql": migration0,
  "0002_phase2_drive.sql": migration1,
  "0003_cli_auth.sql": migration2,
  "0004_access_logs.sql": migration3,
  "0005_comments.sql": migration4,
  "0006_comment_events.sql": migration5,
  "0007_deploy_events.sql": migration6,
  "0008_actor_kind.sql": migration7,
  "0009_guest_access.sql": migration8,
  "0010_access_drive.sql": migration9,
  "0011_organization_security.sql": migration10
};

describe("organization security migration", () => {
  it("preserves existing keys and projects while expiring pending CLI requests", async () => {
    const db = testEnv().DB;
    const execute = async (sql: string) => {
      for (const statement of sql.split(";").map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
    };
    const entries = Object.entries(migrations).sort(([a], [b]) => a.localeCompare(b));
    for (const [name, sql] of entries) if (!name.includes("0011_")) await execute(sql);
    await db.prepare("INSERT INTO users (id, google_id, email) VALUES ('migration-user', 'migration-google', 'migration@example.test')").run();
    await db.prepare("INSERT INTO projects (id, alias, title, created_by) VALUES ('migration-project', 'migration-project', 'Keep this document', 'migration-user')").run();
    await db.prepare("INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix) VALUES ('old-key', 'migration-user', 'legacy CI', 'dummy-hash', 'dummy-prefix')").run();
    await db.prepare("INSERT INTO cli_auth_states (state, expires_at) VALUES ('old-cli-request', 9999999999)").run();
    await execute(entries.find(([name]) => name.includes("0011_"))![1]);
    const key = await db.prepare("SELECT revoked_at, project_id FROM api_keys WHERE id = 'old-key'").first<{ revoked_at: string | null; project_id: string | null }>();
    expect(key?.revoked_at).toBeNull();
    expect(key?.project_id).toBeNull();
    expect(await db.prepare("SELECT 1 FROM cli_auth_states").first()).toBeNull();
    expect(await db.prepare("SELECT title FROM projects WHERE id = 'migration-project'").first()).toEqual({ title: "Keep this document" });
  });
});
