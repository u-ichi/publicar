import { zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../auth/session";
import { upsertProjectFile } from "../db/project-files";
import { createProject, updateProject, upsertProjectMember } from "../db/projects";
import app from "../index";
import { getValidAccessToken } from "../lib/token-refresh";
import { authCookie, avatarUser, editorUser, jsonResponse, mockDriveUploads, resetDatabase, seedUser, testEnv, user, type Env } from "./helpers";

describe("CLI Auth Flow", () => {
  beforeEach(async () => {
    await resetDatabase(testEnv());
  });

  it("initiates CLI auth flow and redirects to OAuth login", async () => {
    const localEnv = testEnv();
    const state = "a".repeat(32) + "test-state-token";

    const response = await app.fetch(new Request(`http://localhost/auth/cli?state=${state}`), localEnv);

    expect(response.status).toBe(302);
    const location = response.headers.get("Location")!;
    expect(location).toContain("/auth/login");
    expect(location).toContain("redirectTo=");
    expect(location).toContain("cli_state");

    const row = await localEnv.DB.prepare("SELECT state, status FROM cli_auth_states WHERE state = ?")
      .bind(state)
      .first<{ state: string; status: string }>();
    expect(row).not.toBeNull();
    expect(row!.status).toBe("pending");
  });

  it("rejects CLI auth with missing or short state", async () => {
    const localEnv = testEnv();

    const noState = await app.fetch(new Request("http://localhost/auth/cli"), localEnv);
    expect(noState.status).toBe(400);
    await expect(noState.json()).resolves.toEqual({ error: "invalid_state" });

    const shortState = await app.fetch(new Request("http://localhost/auth/cli?state=tooshort"), localEnv);
    expect(shortState.status).toBe(400);
    await expect(shortState.json()).resolves.toEqual({ error: "invalid_state" });
  });

  it("rejects duplicate CLI auth state", async () => {
    const localEnv = testEnv();
    const state = "b".repeat(32) + "duplicate-test";

    const first = await app.fetch(new Request(`http://localhost/auth/cli?state=${state}`), localEnv);
    expect(first.status).toBe(302);

    const second = await app.fetch(new Request(`http://localhost/auth/cli?state=${state}`), localEnv);
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toEqual({ error: "duplicate_state" });
  });

  it("completes CLI auth callback and creates API key", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const state = "c".repeat(32) + "callback-test";
    const now = Math.floor(Date.now() / 1000);

    await localEnv.DB.prepare("INSERT INTO cli_auth_states (state, status, expires_at) VALUES (?, 'pending', ?)")
      .bind(state, now + 300)
      .run();

    const response = await app.fetch(
      new Request(`http://localhost/auth/cli/callback?cli_state=${state}`, {
        headers: { Cookie: cookie }
      }),
      localEnv
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("CLI 認証完了");

    const row = await localEnv.DB.prepare("SELECT status, api_key_raw FROM cli_auth_states WHERE state = ?")
      .bind(state)
      .first<{ status: string; api_key_raw: string }>();
    expect(row!.status).toBe("completed");
    expect(row!.api_key_raw).toMatch(/^v1\./);
    expect(row!.api_key_raw).not.toContain("pub_");

    const apiKeyRow = await localEnv.DB.prepare("SELECT name FROM api_keys WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(user.id)
      .first<{ name: string }>();
    expect(apiKeyRow!.name).toContain("CLI");
  });

  it("redirects CLI callback to login when session is missing", async () => {
    const localEnv = testEnv();
    const state = "d".repeat(32) + "no-session";
    const now = Math.floor(Date.now() / 1000);

    await localEnv.DB.prepare("INSERT INTO cli_auth_states (state, status, expires_at) VALUES (?, 'pending', ?)")
      .bind(state, now + 300)
      .run();

    const response = await app.fetch(new Request(`http://localhost/auth/cli/callback?cli_state=${state}`), localEnv);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/auth/login");
  });

  it("returns 410 for expired CLI state on callback", async () => {
    const localEnv = testEnv();
    const cookie = await authCookie(localEnv);
    const state = "e".repeat(32) + "expired-test";
    const now = Math.floor(Date.now() / 1000);

    await localEnv.DB.prepare("INSERT INTO cli_auth_states (state, status, expires_at) VALUES (?, 'pending', ?)")
      .bind(state, now - 10)
      .run();

    const response = await app.fetch(
      new Request(`http://localhost/auth/cli/callback?cli_state=${state}`, {
        headers: { Cookie: cookie }
      }),
      localEnv
    );

    expect(response.status).toBe(410);
    const html = await response.text();
    expect(html).toContain("有効期限");
  });

  it("polls CLI auth state and returns API key on completion", async () => {
    const localEnv = testEnv();
    const state = "f".repeat(32) + "poll-complete";
    const now = Math.floor(Date.now() / 1000);
    const rawKey = "pub_test-key-for-polling";

    await localEnv.DB.prepare("INSERT INTO cli_auth_states (state, status, api_key_raw, expires_at) VALUES (?, 'completed', ?, ?)")
      .bind(state, rawKey, now + 300)
      .run();

    const response = await app.fetch(new Request(`http://localhost/auth/cli/poll?state=${state}`), localEnv);

    expect(response.status).toBe(200);
    const json = (await response.json()) as { status: string; api_key: string };
    expect(json.status).toBe("completed");
    expect(json.api_key).toBe(rawKey);

    const secondPoll = await app.fetch(new Request(`http://localhost/auth/cli/poll?state=${state}`), localEnv);
    expect(secondPoll.status).toBe(404);
  });

  it("returns 202 when CLI auth is still pending", async () => {
    const localEnv = testEnv();
    const state = "g".repeat(32) + "poll-pending";
    const now = Math.floor(Date.now() / 1000);

    await localEnv.DB.prepare("INSERT INTO cli_auth_states (state, status, expires_at) VALUES (?, 'pending', ?)")
      .bind(state, now + 300)
      .run();

    const response = await app.fetch(new Request(`http://localhost/auth/cli/poll?state=${state}`), localEnv);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: "pending" });
  });

  it("returns 404 for unknown or expired CLI auth state on poll", async () => {
    const localEnv = testEnv();
    const unknownState = "h".repeat(32) + "unknown";

    const unknownResponse = await app.fetch(new Request(`http://localhost/auth/cli/poll?state=${unknownState}`), localEnv);
    expect(unknownResponse.status).toBe(404);
    await expect(unknownResponse.json()).resolves.toEqual({ error: "not_found" });

    const expiredState = "i".repeat(32) + "expired-poll";
    const now = Math.floor(Date.now() / 1000);
    await localEnv.DB.prepare("INSERT INTO cli_auth_states (state, status, expires_at) VALUES (?, 'pending', ?)")
      .bind(expiredState, now - 10)
      .run();

    const expiredResponse = await app.fetch(new Request(`http://localhost/auth/cli/poll?state=${expiredState}`), localEnv);
    expect(expiredResponse.status).toBe(404);
  });

  it("completes full CLI auth flow end-to-end", async () => {
    const localEnv = testEnv();
    const state = "j".repeat(32) + "e2e-full-flow";

    const initResponse = await app.fetch(new Request(`http://localhost/auth/cli?state=${state}`), localEnv);
    expect(initResponse.status).toBe(302);

    const pendingResponse = await app.fetch(new Request(`http://localhost/auth/cli/poll?state=${state}`), localEnv);
    expect(pendingResponse.status).toBe(202);

    const cookie = await authCookie(localEnv);
    const callbackResponse = await app.fetch(
      new Request(`http://localhost/auth/cli/callback?cli_state=${state}`, {
        headers: { Cookie: cookie }
      }),
      localEnv
    );
    expect(callbackResponse.status).toBe(200);

    const pollResponse = await app.fetch(new Request(`http://localhost/auth/cli/poll?state=${state}`), localEnv);
    expect(pollResponse.status).toBe(200);
    const pollJson = (await pollResponse.json()) as { status: string; api_key: string };
    expect(pollJson.status).toBe("completed");
    expect(pollJson.api_key).toMatch(/^pub_/);

    const whoamiResponse = await app.fetch(
      new Request("http://localhost/api/v1/whoami", {
        headers: { Authorization: `Bearer ${pollJson.api_key}` }
      }),
      localEnv
    );
    expect(whoamiResponse.status).toBe(200);
    const whoami = (await whoamiResponse.json()) as { user: { email: string } };
    expect(whoami.user.email).toBe(user.email);
  });

});
