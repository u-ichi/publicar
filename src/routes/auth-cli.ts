import { Hono } from "hono";
import { getActiveSessionUser, getStoredSession } from "../auth/session";
import { createApiKey, deleteApiKey } from "../db/api-keys";
import {
  completeCliAuthState,
  consumeCliAuthState,
  findCliAuthState,
  insertCliAuthState
} from "../db/cli-auth";
import type { AppBindings } from "../env";

export const cliAuthRoute = new Hono<AppBindings>();

cliAuthRoute.get("/cli", async (c) => {
  const state = c.req.query("state");
  if (!state || !/^[A-Za-z0-9_-]{32,128}$/.test(state)) {
    return c.json({ error: "invalid_state" }, 400);
  }

  try {
    await insertCliAuthState(c.env, state);
  } catch (e) {
    if (e instanceof Error && e.message.includes("UNIQUE")) {
      return c.json({ error: "duplicate_state" }, 409);
    }
    throw e;
  }

  const redirectTo = `/auth/cli/callback?cli_state=${encodeURIComponent(state)}`;
  return c.redirect(`/auth/login?redirectTo=${encodeURIComponent(redirectTo)}`, 302);
});

cliAuthRoute.get("/cli/callback", async (c) => {
  const cliState = c.req.query("cli_state");
  if (!cliState) {
    return c.json({ error: "missing_cli_state" }, 400);
  }

  const user = await getActiveSessionUser(c.req.raw, c.env);
  const session = await getStoredSession(c.req.raw, c.env);
  if (!user || !session || Date.now() - session.createdAt > 15 * 60000) {
    const redirectTo = `/auth/cli/callback?cli_state=${encodeURIComponent(cliState)}`;
    return c.redirect(`/auth/login?redirectTo=${encodeURIComponent(redirectTo)}`, 302);
  }
  if (user.kind === "guest") return c.json({ error: "forbidden" }, 403);
  c.set("user", user);
  c.set("authMethod", "session");
  // ログイン直後のセッションで、同意画面を挟まずにキーを発行する
  const claimed = await c.env.DB.prepare(`UPDATE cli_auth_states SET status = 'authorizing'
    WHERE state = ? AND status = 'pending' AND expires_at > ?`)
    .bind(cliState, Math.floor(Date.now() / 1000)).run();
  if (!claimed.meta.changes) return c.html(errorHtml("認証リンクの有効期限が切れました。CLI から再度実行してください。"), 410);
  const { rawKey, apiKey } = await createApiKey(c.env, user.id, { name: "CLI" });
  c.set("apiKeyId", apiKey.id);
  try {
    if (!(await completeCliAuthState(c.env, cliState, rawKey, apiKey.id))) {
      await deleteApiKey(c.env, apiKey.id, user.id);
      return c.html(errorHtml("認証リンクの有効期限が切れました。CLI から再度実行してください。"), 410);
    }
  } catch (error) {
    await deleteApiKey(c.env, apiKey.id, user.id);
    throw error;
  }
  return c.html(successHtml());
});

cliAuthRoute.get("/cli/poll", async (c) => {
  const state = c.req.query("state");
  if (!state) {
    return c.json({ error: "missing_state" }, 400);
  }

  const consumed = await consumeCliAuthState(c.env, state);
  if (consumed) {
    return c.json({ status: "completed", api_key: consumed.apiKeyRaw });
  }

  const pending = await findCliAuthState(c.env, state);
  if (pending) {
    return c.json({ status: "pending" }, 202);
  }

  return c.json({ error: "not_found" }, 404);
});

function successHtml(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><title>CLI 認証完了</title>
<style>
body { font-family: system-ui, sans-serif; display: flex; justify-content: center;
       align-items: center; min-height: 100vh; margin: 0; background: #f8f9fa; }
.card { background: white; border-radius: 12px; padding: 2rem 3rem; text-align: center;
        box-shadow: 0 2px 8px rgba(0,0,0,0.1); max-width: 400px; }
h1 { color: #16a34a; font-size: 1.5rem; }
p { color: #6b7280; }
</style></head>
<body><div class="card">
<h1>CLI 認証完了</h1>
<p>このタブを閉じて CLI に戻ってください。<br>API キーが自動的に設定されます。</p>
</div></body></html>`;
}

function errorHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><title>CLI 認証エラー</title>
<style>
body { font-family: system-ui, sans-serif; display: flex; justify-content: center;
       align-items: center; min-height: 100vh; margin: 0; background: #f8f9fa; }
.card { background: white; border-radius: 12px; padding: 2rem 3rem; text-align: center;
        box-shadow: 0 2px 8px rgba(0,0,0,0.1); max-width: 400px; }
h1 { color: #dc2626; font-size: 1.5rem; }
p { color: #6b7280; }
</style></head>
<body><div class="card">
<h1>認証エラー</h1>
<p>${message}</p>
</div></body></html>`;
}
