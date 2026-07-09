import type { AppBindings, AuthUser } from "../../env";
import type { Context } from "hono";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function firstAllowedDomain(c: Context<AppBindings>): string {
  return (c.env.ALLOWED_SIGNUP_DOMAINS ?? "")
    .split(",")
    .map((domain) => domain.trim())
    .filter(Boolean)[0] ?? "your organization";
}

export type AvatarSubject = {
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
};

export function avatarInitials(subject: Pick<AvatarSubject, "name" | "email">): string {
  const source = subject.name || subject.email || "?";
  return source.slice(0, 2).toUpperCase();
}

export function safeAvatarUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

export function avatarHtml(subject: AvatarSubject, extraClass = ""): string {
  const className = extraClass ? `avatar ${extraClass}` : "avatar";
  const avatarUrl = safeAvatarUrl(subject.avatarUrl);
  if (avatarUrl) {
    return `<img class="${escapeHtml(className)}" src="${escapeHtml(avatarUrl)}" alt="" referrerpolicy="no-referrer">`;
  }
  return `<span class="${escapeHtml(className)}">${escapeHtml(avatarInitials(subject))}</span>`;
}

export function userIdentityHtml(subject: AvatarSubject): string {
  const name = subject.name || subject.email || "unknown";
  const email = subject.email && subject.email !== name ? `<span class="user-identity-email">${escapeHtml(subject.email)}</span>` : "";
  return `<span class="user-identity">${avatarHtml(subject, "inline-avatar")}<span class="user-identity-text"><span class="user-identity-name">${escapeHtml(name)}</span>${email}</span></span>`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="icon" type="image/svg+xml" sizes="16x16" href="/icon-16.svg">
  <link rel="icon" type="image/svg+xml" sizes="32x32" href="/icon-32.svg">
  <link rel="manifest" href="/site.webmanifest">
  <meta name="theme-color" content="#2563eb">
  <style>
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    :root, [data-theme="dark"] {
      --bg:#0a0a0a; --surface:#1a1a1a; --surface-2:#141414; --surface-hover:#222;
      --el:#2a2a2a; --border:#282828; --border-2:#333; --border-sub:#1e1e1e;
      --tx:#e0e0e0; --tx-2:#999; --tx-3:#666; --logo:#fff; --shadow:none; color-scheme:dark;
      --accent:#58a6ff; --accent-bg:rgba(56,139,253,.15); --accent-fg:#58a6ff;
      --border-active:#58a6ff; --highlight:rgba(210,153,34,.18); --highlight-active:rgba(210,153,34,.35);
      --highlight-border:rgba(210,153,34,.5); --green:#3fb950; --green-bg:rgba(63,185,80,.15);
      --red:#f85149; --red-bg:rgba(248,81,73,.15); --orange:#d29922;
    }
    [data-theme="light"] {
      --bg:#f5f6fa; --surface:#fff; --surface-2:#fafbfc; --surface-hover:#f0f1f3;
      --el:#e5e7eb; --border:#e2e5e9; --border-2:#d1d5db; --border-sub:#f0f1f3;
      --tx:#111827; --tx-2:#6b7280; --tx-3:#9ca3af; --logo:#111827; --shadow:0 1px 3px rgba(0,0,0,0.08); color-scheme:light;
      --accent:#0969da; --accent-bg:rgba(9,105,218,.10); --accent-fg:#0969da;
      --border-active:#0969da; --highlight:rgba(210,153,34,.16); --highlight-active:rgba(210,153,34,.30);
      --highlight-border:rgba(210,153,34,.48); --green:#1a7f37; --green-bg:rgba(26,127,55,.12);
      --red:#cf222e; --red-bg:rgba(207,34,46,.10); --orange:#9a6700;
    }
    body { margin: 0; background: var(--bg); color: var(--tx); font: 14px/1.5 system-ui, -apple-system, sans-serif; -webkit-font-smoothing: antialiased; }
    a { color: #3b82f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
    button, input, select, textarea { font: inherit; }
    button { cursor: pointer; }
    input, select { width: 100%; min-height: 38px; padding: 9px 11px; border-radius: 6px; border: 1px solid var(--border-2); background: var(--surface-2); color: var(--tx); }
    input:focus, select:focus, textarea:focus, button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    label { display: grid; gap: 6px; color: var(--tx-2); font-size: 13px; }
    .app-shell { min-height: 100vh; background: var(--bg); color: var(--tx); }
    .header { height: 56px; position: sticky; top: 0; z-index: 50; display: flex; align-items: center; justify-content: space-between; padding: 0 24px; border-bottom: 1px solid var(--border); background: var(--bg); }
    .brand { display: inline-flex; align-items: center; gap: 8px; color: var(--logo); font: 700 15px/1 ui-monospace, monospace; letter-spacing: .06em; }
    .brand-logo { width: 20px; height: 20px; display: block; border-radius: 4px; flex: none; }
    .header-actions { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .icon-button { width: 31px; height: 31px; display: inline-grid; place-items: center; color: var(--tx-2); background: transparent; border: 1px solid var(--border); border-radius: 6px; }
    .icon-button:hover, .menu:hover { background: var(--surface-hover); border-color: var(--border-2); }
    .notification-wrap { position: relative; }
    .notification-badge { position: absolute; top: -5px; right: -5px; min-width: 16px; height: 16px; padding: 0 4px; display: none; place-items: center; border-radius: 999px; background: #ef4444; color: #fff; font-size: 10px; font-weight: 700; line-height: 16px; }
    .notification-badge.active { display: grid; }
    .notification-panel { position: absolute; right: 0; top: 38px; width: min(360px, calc(100vw - 32px)); max-height: 420px; overflow: auto; display: none; background: var(--surface); border: 1px solid var(--border-2); border-radius: 8px; box-shadow: var(--shadow); z-index: 80; }
    .notification-wrap.open .notification-panel { display: block; }
    .notification-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
    .notification-head button { border: 0; background: transparent; color: #3b82f6; padding: 0; font-size: 12px; }
    .notification-list { display: grid; }
    .notification-item { display: grid; gap: 5px; padding: 11px 12px; border-bottom: 1px solid var(--border-sub); color: var(--tx); text-align: left; background: transparent; border-left: 0; border-right: 0; border-top: 0; }
    .notification-item:hover { background: var(--surface-hover); text-decoration: none; }
    .notification-title { font-weight: 650; font-size: 13px; }
    .notification-body { color: var(--tx-2); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .notification-empty { padding: 18px 12px; color: var(--tx-3); font-size: 13px; }
    .menu { position: relative; display: flex; align-items: center; gap: 8px; min-width: 0; border: 1px solid var(--border); border-radius: 8px; padding: 3px 8px 3px 3px; color: var(--tx); }
    .avatar { width: 30px; height: 30px; border-radius: 50%; display: inline-grid; place-items: center; background: var(--el); color: var(--tx); font-size: 12px; font-weight: 600; flex: none; overflow: hidden; }
    img.avatar { display: inline-block; object-fit: cover; }
    .inline-avatar { margin-right: 8px; vertical-align: middle; }
    .user-identity { display: inline-flex; align-items: center; gap: 8px; min-width: 0; vertical-align: middle; }
    .user-identity .inline-avatar { margin-right: 0; }
    .user-identity-text { display: grid; gap: 2px; min-width: 0; }
    .user-identity-name, .user-identity-email { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .user-identity-name { color: var(--tx-2); }
    .user-identity-email { color: var(--tx-3); font-size: 12px; line-height: 1.3; }
    .email { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
    .dropdown { display: none; position: absolute; right: 0; top: 38px; min-width: 190px; background: var(--surface); border: 1px solid var(--border-2); border-radius: 8px; padding: 6px; box-shadow: var(--shadow); }
    .menu:focus-within .dropdown, .menu:hover .dropdown { display: grid; }
    .dropdown a, .dropdown span { padding: 9px 10px; border-radius: 6px; color: var(--tx); font-size: 13px; }
    .dropdown span { color: var(--tx-3); }
    .main { width: min(1200px, calc(100vw - 32px)); margin: 0 auto; padding: 28px 0 44px; }
    .main.full-bleed { width: 100%; padding: 0; }
    .toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 20px; }
    .search { flex: 1; position: relative; min-width: 180px; }
    .search input { padding-left: 34px; }
    .search svg { position: absolute; left: 11px; top: 11px; color: var(--tx-3); }
    .button { min-height: 38px; border: 1px solid #3b82f6; border-radius: 6px; padding: 9px 14px; background: #3b82f6; color: #fff; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; gap: 8px; white-space: nowrap; }
    .button:hover { background: #2563eb; text-decoration: none; }
    .button.secondary { background: transparent; border-color: var(--border-2); color: var(--tx); }
    .button.danger { background: #ef4444; border-color: #ef4444; }
    .button:disabled { cursor: not-allowed; opacity: .48; }
    .segmented { display: inline-flex; border: 1px solid var(--border-2); border-radius: 6px; overflow: hidden; background: var(--surface-2); }
    .segmented button { width: 38px; min-height: 36px; border: 0; border-left: 1px solid var(--border-2); padding: 7px; background: transparent; color: var(--tx-2); display: inline-grid; place-items: center; }
    .segmented button:first-child { border-left: 0; }
    .segmented button[aria-pressed="true"] { background: var(--el); color: var(--tx); }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
    .grid[hidden], .project-list[hidden] { display: none; }
    .project-list { overflow-x: auto; }
    .card { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); padding: 18px; box-shadow: var(--shadow); display: grid; gap: 14px; min-height: 168px; }
    .card:hover { border-color: var(--border-2); }
    .card-head { display: flex; justify-content: space-between; gap: 14px; align-items: start; }
    h1, h2, h3 { margin: 0; color: var(--tx); }
    h1 { font-size: 22px; line-height: 1.2; font-weight: 600; }
    h2 { font-size: 16px; font-weight: 600; }
    h3 { font-size: 15px; font-weight: 600; }
    .mono { font-family: ui-monospace, monospace; }
    .muted { color: var(--tx-3); }
    .subtle { color: var(--tx-2); }
    .badges { display: flex; flex-wrap: wrap; gap: 6px; }
    .badge { display: inline-flex; align-items: center; border-radius: 4px; padding: 2px 6px; font-size: 12px; font-weight: 600; }
    .visibility-private { background: rgba(239,68,68,.15); color:#ef4444; }
    .visibility-invite { background: rgba(249,115,22,.15); color:#f97316; }
    .visibility-domain { background: rgba(59,130,246,.15); color:#3b82f6; }
    .visibility-link { background: rgba(34,197,94,.15); color:#22c55e; }
    .visibility-public { background: rgba(136,136,136,.15); color:#888; }
    .role-owner { background: rgba(59,130,246,.15); color:#3b82f6; }
    .role-editor { background: rgba(249,115,22,.15); color:#f97316; }
    .role-viewer { background: rgba(136,136,136,.15); color:#888; }
    .meta-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--tx-3); font-size: 12px; }
    .panel { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); padding: 20px; box-shadow: var(--shadow); }
    .stack { display: grid; gap: 16px; }
    .row { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; }
    .status { min-height: 20px; font-size: 13px; color: var(--tx-2); }
    .ok { color: #22c55e; }
    .error { color: #ef4444; }
    .danger-zone { border-top: 1px solid var(--border); padding-top: 16px; display: grid; gap: 10px; }
    .empty { padding: 28px 0; color: var(--tx-3); }
    .login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .login-card { width: min(400px, 100%); background: var(--surface); border: 1px solid var(--border-2); border-radius: 12px; padding: 48px 40px; text-align: center; }
    .login-logo { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 12px; color: var(--logo); font: 700 28px/1 ui-monospace, monospace; letter-spacing: .08em; }
    .login-logo-mark { width: 28px; height: 28px; display: block; border-radius: 6px; flex: none; }
    .google-button { width: 100%; padding: 12px 16px; background: #fff; border: 1px solid #dadce0; color: #3c4043; border-radius: 6px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; gap: 10px; }
    .crumbs { display: flex; gap: 8px; align-items: center; color: var(--tx-3); margin-bottom: 18px; font-size: 13px; }
    .title-row { display: flex; align-items: start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
    .title-stack { display: grid; gap: 8px; }
    .tabs { display: flex; gap: 18px; border-bottom: 1px solid var(--border); margin-bottom: 18px; overflow-x: auto; }
    .tab { padding: 0 0 10px; border: 0; border-bottom: 2px solid transparent; color: var(--tx-3); background: transparent; white-space: nowrap; }
    .tab[aria-selected="true"] { color: var(--tx); border-bottom-color: #3b82f6; }
    .tab-panel { display: none; }
    .tab-panel.active { display: grid; gap: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th { padding: 10px 16px; text-align: left; color: var(--tx-3); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; background: var(--surface-2); }
    td { padding: 12px 16px; border-top: 1px solid var(--border-sub); color: var(--tx-2); vertical-align: middle; }
    .right { text-align: right; }
    .comment-history-list { display: grid; gap: 10px; }
    .comment-history-item { text-align: left; }
    .comment-history-item:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .comment-history-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; min-width: 0; }
    .comment-history-main { display: grid; gap: 6px; min-width: 0; }
    .comment-history-link { color: var(--tx); font-weight: 600; overflow-wrap: anywhere; }
    .comment-history-quote { margin: 0; }
    .comment-history-meta { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; color: var(--tx-3); font-size: 12px; }
    .comment-history-path { max-width: min(420px, 100%); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .comment-history-events { margin: 0; padding: 8px 0 0 0; display: grid; gap: 6px; border-top: 1px solid var(--border); list-style: none; }
    .comment-history-event { display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 10px; color: var(--tx-2); font-size: 12px; }
    .comment-history-event-time { color: var(--tx-3); }
    .comment-history-event-body { color: var(--tx); overflow-wrap: anywhere; }
    .comment-history-event-note { color: var(--tx-3); }
    .comment-history-tools { align-items: center; justify-content: space-between; }
    .comment-history-tools label { width: 180px; }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; max-width: 720px; }
    .form-grid .full { grid-column: 1 / -1; }
    .review-shell { width: min(1600px, calc(100vw - 24px)); margin: 0 auto; padding: 16px 0 28px; }
    .review-topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .review-layout { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 14px; min-height: calc(100vh - 132px); }
    .review-frame-wrap { border: 1px solid var(--border); border-radius: 8px; background: #fff; overflow: hidden; min-height: 640px; }
    .review-frame { width: 100%; height: calc(100vh - 146px); min-height: 640px; border: 0; background: #fff; }
    .review-rail { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); display: grid; grid-template-rows: auto 1fr; min-height: 0; overflow: hidden; }
    .review-rail-head { min-height: 48px; padding: 10px 12px 10px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .review-rail-title { display: inline-flex; align-items: baseline; gap: 7px; min-width: 0; font-size: 14px; font-weight: 650; }
    .review-rail-title .muted { font-size: 12px; font-weight: 500; }
    .review-rail-tools { display: inline-flex; align-items: center; gap: 7px; flex: none; }
    .review-rail-tools select { width: auto; min-height: 29px; padding: 4px 24px 4px 8px; border-radius: 5px; font-size: 12px; color: var(--tx-2); background-color: var(--surface-2); }
    .review-close { width: 28px; height: 28px; display: inline-grid; place-items: center; border: 0; border-radius: 5px; background: transparent; color: var(--tx-3); font-size: 18px; line-height: 1; }
    .review-close:hover { background: var(--surface-hover); color: var(--tx); }
    .review-filter { display: none; }
    .review-comments { overflow: auto; padding: 12px; display: grid; gap: 10px; align-content: start; }
    .review-card { display: grid; gap: 9px; border: 1px solid var(--border); border-radius: 8px; background: transparent; padding: 14px; cursor: pointer; transition: border-color .15s ease, background .15s ease, box-shadow .15s ease; }
    .review-card:hover { border-color: var(--border-2); }
    .review-card[data-status="resolved"] { opacity: .82; }
    .review-card.active { border-color: var(--border-active); background: var(--surface-2); box-shadow: 0 0 0 1px color-mix(in srgb, var(--border-active) 24%, transparent); }
    .review-card-head { display: flex; align-items: flex-start; gap: 9px; min-width: 0; }
    .review-card-avatar { width: 32px; height: 32px; border-radius: 50%; display: inline-grid; place-items: center; flex: none; background: var(--el); color: var(--tx-2); font-size: 13px; font-weight: 650; }
    .review-card-author { display: grid; gap: 1px; min-width: 0; }
    .review-card-author strong { color: var(--tx); font-size: 13px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .comment-actor-ai { display: inline-flex; align-items: center; gap: 3px; width: fit-content; margin-left: 6px; padding: 1px 5px; border-radius: 4px; background: color-mix(in srgb, var(--blue) 12%, transparent); color: var(--blue); font-size: 10px; font-weight: 650; vertical-align: 1px; }
    .review-card-time { color: var(--tx-3); font-size: 11px; }
    .review-status { display: inline-flex; align-items: center; gap: 4px; width: fit-content; padding: 2px 6px; border-radius: 4px; background: var(--el); color: var(--tx-3); font-size: 11px; }
    .review-status.resolved { background: var(--green-bg); color: var(--green); }
    .review-quote { margin: 0; padding: 6px 10px; border-left: 2px solid var(--orange); border-radius: 0 4px 4px 0; background: rgba(210,153,34,.06); color: var(--tx-3); font-size: 12px; line-height: 1.5; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .review-body { color: var(--tx); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.6; }
    .review-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--tx-3); font-size: 11px; }
    .review-replies { display: grid; gap: 8px; padding-top: 10px; border-top: 1px solid var(--border); }
    .review-replies:empty { display: none; }
    .review-reply { display: flex; gap: 8px; color: var(--tx-2); font-size: 12px; }
    .review-reply-avatar { width: 26px; height: 26px; border-radius: 50%; display: inline-grid; place-items: center; flex: none; background: var(--el); color: var(--tx-2); font-size: 10px; font-weight: 650; }
    .review-reply-body { display: grid; gap: 2px; min-width: 0; }
    .review-actions { display: grid; gap: 8px; }
    .review-action-row { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
    .review-action-row .button { min-height: 30px; padding: 4px 10px; border-radius: 5px; font-size: 12px; }
    .review-action-row .button.secondary:hover { border-color: var(--border-2); color: var(--tx); }
    .review-action-row .button.danger-link:hover { border-color: var(--red); color: var(--red); }
    .review-action-row .button.resolve-link:hover { border-color: var(--green); color: var(--green); }
    .review-actions textarea, .comment-composer textarea { width: 100%; min-height: 56px; resize: vertical; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2); color: var(--tx); font-size: 13px; line-height: 1.5; }
    .comment-popover { position: fixed; z-index: 100; width: min(320px, calc(100vw - 32px)); display: none; gap: 8px; padding: 10px 12px; border: 1px solid var(--border-2); border-radius: 8px; background: var(--surface); box-shadow: 0 4px 16px rgba(0,0,0,.25); }
    .comment-popover.open { display: grid; animation: popIn .12s ease forwards; }
    .comment-popover textarea { min-height: 48px; resize: none; }
    .comment-popover-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .comment-shortcut { color: var(--tx-3); font-size: 10px; line-height: 1; }
    .comment-popover-actions { display: inline-flex; align-items: center; gap: 8px; }
    .comment-popover-actions .button { min-height: 30px; padding: 4px 10px; border-radius: 5px; font-size: 12px; }
    .comment-toolbar { position: fixed; z-index: 99; display: none; border: 1px solid var(--border-2); border-radius: 6px; background: var(--surface); box-shadow: 0 4px 16px rgba(0,0,0,.18); padding: 6px; }
    .comment-toolbar.open { display: block; }
    .comment-mode-button { min-height: 31px; display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--border); border-radius: 6px; padding: 5px 12px; background: transparent; color: var(--tx-2); font-size: 13px; font-weight: 600; transition: background .15s ease, border-color .15s ease, color .15s ease, opacity .15s ease; }
    .comment-mode-button:hover { background: var(--surface-hover); border-color: var(--border-2); }
    .comment-mode-button[aria-pressed="true"] { color: #fff; background: var(--green); border-color: var(--green); }
    .comment-workbench { position: relative; height: calc(100vh - 56px); min-height: 0; overflow: hidden; background: #fff; }
    .comment-workbench-frame { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
    .comment-workbench .review-rail { position: fixed; z-index: 80; top: 56px; right: 0; bottom: 0; width: min(340px, 100vw); min-height: 0; border-top: 0; border-bottom: 0; border-right: 0; border-radius: 0; box-shadow: -16px 0 32px rgba(15, 23, 42, .12); transform: translateX(100%); visibility: hidden; pointer-events: none; transition: transform .2s ease, visibility .2s ease; }
    .comment-workbench.comment-rail-open .review-rail { transform: translateX(0); visibility: visible; pointer-events: auto; }
    @keyframes popIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
    @media (max-width: 920px) {
      .review-layout { grid-template-columns: 1fr; }
      .review-frame { height: 62vh; }
      .review-rail { min-height: 360px; }
      .comment-workbench .review-rail { top: auto; left: 0; width: 100vw; max-height: 72vh; border-left: 0; border-top: 1px solid var(--border); transform: translateY(100%); box-shadow: 0 -16px 32px rgba(15,23,42,.12); }
      .comment-workbench.comment-rail-open .review-rail { transform: translateY(0); }
    }
    dialog { width: min(520px, calc(100vw - 32px)); border: 1px solid var(--border-2); border-radius: 12px; padding: 0; background: var(--surface); color: var(--tx); }
    dialog::backdrop { background: rgba(0,0,0,.64); }
    .modal-body { padding: 28px; display: grid; gap: 16px; }
    @media (max-width: 900px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 640px) {
      .header { padding: 0 14px; }
      .email { display: none; }
      .main { width: min(100% - 24px, 1200px); padding-top: 20px; }
      .toolbar, .title-row { align-items: stretch; flex-direction: column; }
      .comment-history-head { display: grid; }
      .comment-history-event { grid-template-columns: 1fr; gap: 2px; }
      .comment-history-tools { align-items: stretch; }
      .comment-history-tools label { width: 100%; }
      .grid, .form-grid { grid-template-columns: 1fr; }
      .login-card { padding: 40px 24px; }
    }
  </style>
  <script>
    ${clientBaseScript()}
    const savedTheme = localStorage.getItem("publicar-theme") || "dark";
    document.documentElement.dataset.theme = savedTheme;
  </script>
</head>
<body>${body}</body>
</html>`;
}

export function googleIcon(): string {
  return `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"></path><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"></path><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"></path><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"></path></svg>`;
}

export function iconGrid(size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect></svg>`;
}

export function iconList(size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>`;
}

export function iconBell(size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path><path d="M13.7 21a2 2 0 0 1-3.4 0"></path></svg>`;
}

export type ShellOptions = {
  mainClass?: string;
  headerControls?: string;
};

export function shell(user: AuthUser, content: string, options: ShellOptions = {}): string {
  const mainClass = options.mainClass ? `main ${options.mainClass}` : "main";
  return `<div class="app-shell">
  <header class="header">
    <a class="brand" href="/" aria-label="Dashboard"><img class="brand-logo" src="/logo-mark.svg" width="20" height="20" alt=""><span>publicar</span></a>
    <div class="header-actions">
      ${options.headerControls ?? ""}
      <button class="icon-button" type="button" data-theme-toggle aria-label="テーマ切替">☀</button>
      <div class="notification-wrap" data-notification-root>
        <button class="icon-button" type="button" data-notification-toggle aria-label="通知">${iconBell()}</button>
        <span class="notification-badge" data-notification-badge></span>
        <section class="notification-panel" data-notification-panel>
          <div class="notification-head"><strong>通知</strong><button type="button" data-notification-read-all>すべて既読</button></div>
          <div class="notification-list" data-notification-list><div class="notification-empty">読み込み中...</div></div>
        </section>
      </div>
      <div class="menu" tabindex="0">
        ${avatarHtml(user)}
        <span class="email">${escapeHtml(user.email)}</span>
        <span aria-hidden="true">⌄</span>
        <div class="dropdown">
          <span>API キー管理 近日対応</span>
          <a href="/auth/logout">ログアウト</a>
        </div>
      </div>
    </div>
  </header>
  <main class="${escapeHtml(mainClass)}">${content}</main>
</div>
<script>initSharedUi();</script>`;
}

export function clientBaseScript(): string {
  return `
function qs(selector, root = document) { return root.querySelector(selector); }
function qsa(selector, root = document) { return Array.from(root.querySelectorAll(selector)); }
function setStatus(el, text, kind) { if (!el) return; el.className = kind ? "status " + kind : "status"; el.textContent = text; }
function errorText(payload, fallback) { return payload && payload.error ? fallback + ": " + payload.error : fallback; }
function safeAvatarUrl(value) { if (!value) return null; try { const url = new URL(String(value)); return url.protocol === "https:" ? String(value) : null; } catch { return null; } }
function avatarInitials(name, email) { return String(name || email || "?").slice(0, 2).toUpperCase(); }
function avatarNode(name, email, avatarUrl) {
  const safeUrl = safeAvatarUrl(avatarUrl);
  if (safeUrl) {
    const image = document.createElement("img");
    image.className = "avatar inline-avatar";
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.src = safeUrl;
    return image;
  }
  const avatar = document.createElement("span");
  avatar.className = "avatar inline-avatar";
  avatar.textContent = avatarInitials(name, email);
  return avatar;
}
function userIdentityNode(name, email, avatarUrl) {
  const identity = document.createElement("span");
  identity.className = "user-identity";
  identity.appendChild(avatarNode(name, email, avatarUrl));
  const text = document.createElement("span");
  text.className = "user-identity-text";
  const displayName = name || email || "unknown";
  const nameEl = document.createElement("span");
  nameEl.className = "user-identity-name";
  nameEl.textContent = displayName;
  text.appendChild(nameEl);
  if (email && email !== displayName) {
    const emailEl = document.createElement("span");
    emailEl.className = "user-identity-email";
    emailEl.textContent = email;
    text.appendChild(emailEl);
  }
  identity.appendChild(text);
  return identity;
}
function notificationLabel(item) {
  const actor = item.actor?.name || item.actor?.email || "unknown";
  return item.kind === "comment_replied" ? actor + " が返信しました" : actor + " がコメントしました";
}
async function loadNotifications() {
  const badge = qs("[data-notification-badge]");
  const list = qs("[data-notification-list]");
  if (!badge || !list) return;
  const response = await fetch("/api/v1/notifications?status=unread&limit=10");
  if (!response.ok) return;
  const data = await response.json();
  const count = Number(data.unreadCount || 0);
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.classList.toggle("active", count > 0);
  if (!data.notifications || data.notifications.length === 0) {
    list.innerHTML = '<div class="notification-empty">未読通知はありません</div>';
    return;
  }
  list.innerHTML = "";
  data.notifications.forEach((item) => {
    const link = document.createElement("a");
    link.className = "notification-item";
    link.href = item.url || "#";
    link.addEventListener("click", async () => {
      await fetch("/api/v1/notifications/" + encodeURIComponent(item.id) + "/read", { method: "POST" });
    });
    const title = document.createElement("span");
    title.className = "notification-title";
    title.textContent = notificationLabel(item);
    const body = document.createElement("span");
    body.className = "notification-body";
    body.textContent = item.body || item.title || "";
    link.append(title, body);
    list.appendChild(link);
  });
}
function initSharedUi() {
  qs("[data-theme-toggle]")?.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    const next = current === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("publicar-theme", next);
  });
  qsa("[data-open-modal]").forEach((button) => button.addEventListener("click", () => qs(button.dataset.openModal)?.showModal()));
  qsa("[data-close-modal]").forEach((button) => button.addEventListener("click", () => button.closest("dialog")?.close()));
  const notificationRoot = qs("[data-notification-root]");
  qs("[data-notification-toggle]")?.addEventListener("click", (event) => {
    event.stopPropagation();
    notificationRoot?.classList.toggle("open");
    loadNotifications();
  });
  qs("[data-notification-read-all]")?.addEventListener("click", async () => {
    await fetch("/api/v1/notifications/read-all", { method: "POST" });
    loadNotifications();
  });
  document.addEventListener("click", (event) => {
    if (notificationRoot && !notificationRoot.contains(event.target)) {
      notificationRoot.classList.remove("open");
    }
  });
  loadNotifications();
}
`;
}

export function loginPage(domain: string): string {
  return page(
    "publicar",
    `<div class="app-shell">
  <div class="login-wrap">
    <section class="login-card">
      <div class="login-logo"><img class="login-logo-mark" src="/logo-mark.svg" width="28" height="28" alt=""><span>publicar</span></div>
      <p class="subtle" style="margin:0 0 40px">AI 生成レポート共有基盤</p>
      <a class="google-button" href="/auth/login">${googleIcon()} Google でログイン</a>
      <p class="muted" style="font-size:12px; margin:28px 0 0">@${escapeHtml(domain)} のアカウントでログインしてください</p>
    </section>
  </div>
</div>`
  );
}

export function visibilityBadge(visibility: string): string {
  return `<span class="badge visibility-${escapeHtml(visibility)}">${escapeHtml(visibility)}</span>`;
}

export function roleBadge(role: string): string {
  return `<span class="badge role-${escapeHtml(role)}">${escapeHtml(role)}</span>`;
}

export function driveFolderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;
}
