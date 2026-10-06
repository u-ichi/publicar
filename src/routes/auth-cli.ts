import { Hono } from "hono";
import { getActiveSessionUser, getStoredSession, sessionReference } from "../auth/session";
import { createApiKey, deleteApiKey } from "../db/api-keys";
import {
  completeCliAuthState,
  consumeCliAuthState,
  findCliAuthState,
  insertCliAuthState
} from "../db/cli-auth";
import { randomBase64Url } from "../lib/encoding";
import { sha256Base64Url } from "../lib/crypto";
import { escapeHtml } from "./pages/layout";
import type { AppBindings } from "../env";

// CLIへ渡すキーは全scope・プロジェクト限定なしで発行し、期限だけを固定する
const CLI_KEY_DAYS = 365;

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
  if (!(await findCliAuthState(c.env, cliState))) return c.html(errorHtml("認証リンクの有効期限が切れました。CLI から再度実行してください。"), 410);
  const confirmation = randomBase64Url(32);
  const sessionKey = await sessionReference(c.req.raw, c.env);
  const bound = await c.env.DB.prepare(`UPDATE cli_auth_states SET consent_user_id = ?, consent_session_key = ?, consent_token_hash = ?
    WHERE state = ? AND status = 'pending' AND expires_at > ? AND (consent_user_id IS NULL OR consent_user_id = ?)`)
    .bind(user.id, sessionKey, await sha256Base64Url(confirmation), cliState, Math.floor(Date.now() / 1000), user.id).run();
  if (!bound.meta.changes) return c.json({ error: "cli_state_bound_to_another_user" }, 403);
  c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  c.header("Referrer-Policy", "no-referrer");
  return c.html(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>CLIへの権限付与</title><style>body{font:16px/1.6 system-ui;margin:40px auto;padding:0 20px;max-width:640px;color:#17202a}label{display:block;margin:18px 0}input:not([type=checkbox]){display:block;box-sizing:border-box;width:100%;padding:10px;font:inherit}button{padding:10px 20px;background:#175cd3;color:white;border:0;border-radius:6px;font:inherit}a{margin-left:20px}</style>
    <body><main><h1>CLIへの権限付与</h1><p>自分がこの端末で開始した認証だけを承認してください。他の人から届いたリンクなら閉じてください。</p>
    <p>ログイン中: ${escapeHtml(user.email)}</p><p>認証要求の末尾: ${escapeHtml(cliState.slice(-8))}</p>
    <form method="post" action="/auth/cli/confirm">
      <input type="hidden" name="state" value="${escapeHtml(cliState)}"><input type="hidden" name="confirmation" value="${confirmation}">
      <label>端末の名前 <input name="device_name" required maxlength="100" placeholder="例: 自分のMac"></label>
      <p>この端末のCLIに、閲覧・編集できるプロジェクトの読み取り、コメント、配信ファイルの更新を許可します。有効期間は${CLI_KEY_DAYS}日です。</p>
      <label><input type="checkbox" name="approved" value="yes" required>自分で開始した認証で、上記の権限をこの端末へ渡します</label>
      <button type="submit">権限を付与する</button><a href="/">取り消す</a>
    </form></main></body></html>`);
});

cliAuthRoute.post("/cli/confirm", async (c) => {
  const user = await getActiveSessionUser(c.req.raw, c.env);
  const session = await getStoredSession(c.req.raw, c.env);
  if (!user || user.kind === "guest" || !session || Date.now() - session.createdAt > 15 * 60000) return c.json({ error: "reauthentication_required" }, 403);
  c.set("user", user);
  c.set("authMethod", "session");
  let form: FormData;
  try { form = await c.req.raw.formData(); }
  catch { return c.json({ error: "invalid_confirmation" }, 400); }
  const state = form.get("state");
  const confirmation = form.get("confirmation");
  const name = form.get("device_name");
  if (typeof state !== "string" || typeof confirmation !== "string" || typeof name !== "string" || !name.trim() || name.length > 100 ||
      form.get("approved") !== "yes") return c.json({ error: "invalid_confirmation" }, 400);
  const claimed = await c.env.DB.prepare(`UPDATE cli_auth_states SET status = 'authorizing'
    WHERE state = ? AND status = 'pending' AND expires_at > ? AND consent_user_id = ? AND consent_session_key = ? AND consent_token_hash = ?`)
    .bind(state, Math.floor(Date.now() / 1000), user.id, await sessionReference(c.req.raw, c.env), await sha256Base64Url(confirmation)).run();
  if (!claimed.meta.changes) return c.json({ error: "invalid_or_expired_confirmation" }, 410);
  const { rawKey, apiKey } = await createApiKey(c.env, user.id, { name: `CLI (${name.trim()})`, scopes: ["read", "write", "deploy"],
    projectId: null, expiresAt: new Date(Date.now() + CLI_KEY_DAYS * 86400000).toISOString() });
  c.set("apiKeyId", apiKey.id);
  try {
    if (!(await completeCliAuthState(c.env, state, rawKey, apiKey.id))) {
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
