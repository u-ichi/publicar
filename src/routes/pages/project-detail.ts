import { listDeployEventsWithDeployers, type DeployEventWithDeployer } from "../../db/deploy-events";
import { listProjectFilesWithDeployers, type ProjectFileWithDeployer } from "../../db/project-files";
import { getProjectForUser, listProjectMembers, type Project } from "../../db/projects";
import type { AppBindings, AuthUser } from "../../env";
import type { Context } from "hono";
import { driveFolderUrl, escapeHtml, formatBytes, page, roleBadge, shell, userIdentityHtml, visibilityBadge } from "./layout";

function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function fileRows(projectId: string, files: ProjectFileWithDeployer[]): string {
  if (!files.length) {
    return `<tr><td colspan="4" class="empty">No files</td></tr>`;
  }
  return files
    .map(
      (file) => `<tr data-file-path="${escapeHtml(file.path)}">
  <td class="mono">${escapeHtml(file.path)}</td>
  <td class="right mono">${escapeHtml(formatBytes(file.sizeBytes))}</td>
  <td class="right mono">${escapeHtml(file.driveModifiedTime ?? "unknown")}</td>
  <td class="right"><a class="button secondary" href="/projects/${encodeURIComponent(projectId)}/review?path=${encodeURIComponent(file.path)}">レビュー</a> <button class="button secondary remove-file" type="button">削除</button></td>
</tr>`
    )
    .join("");
}

function deployHistoryRows(deployEvents: DeployEventWithDeployer[]): string {
  if (!deployEvents.length) {
    return `<tr><td colspan="4" class="empty">No deploys</td></tr>`;
  }
  return deployEvents
    .map(
      (event) => `<tr>
  <td class="mono">${escapeHtml(event.deployType === "zip" ? `ZIP (${event.filesCount} files)` : event.path ?? "unknown")}</td>
  <td>${userIdentityHtml({ name: event.name, email: event.email, avatarUrl: event.avatarUrl })}</td>
  <td class="right mono">${escapeHtml(formatBytes(event.totalSizeBytes))}</td>
  <td class="right mono">${escapeHtml(event.deployedAt)}</td>
</tr>`
    )
    .join("");
}

function memberRows(members: Awaited<ReturnType<typeof listProjectMembers>>): string {
  return members
    .map(
      (member) => `<tr data-member-user-id="${escapeHtml(member.userId)}">
  <td>${userIdentityHtml(member)}</td>
  <td>${member.role === "owner" ? roleBadge("owner") : `<select class="member-role" aria-label="role for ${escapeHtml(member.email)}"><option value="editor" selected>editor</option></select>`}</td>
  <td class="mono">${escapeHtml(member.createdAt)}</td>
  <td class="right">${member.role === "owner" ? "" : `<button class="button secondary remove-member" type="button">削除</button>`}</td>
</tr>`
    )
    .join("");
}

function projectDetailPage(
  user: AuthUser,
  project: Project,
  members: Awaited<ReturnType<typeof listProjectMembers>>,
  files: ProjectFileWithDeployer[],
  deployEvents: DeployEventWithDeployer[]
): string {
  const previewUrl = `/${project.alias}/`;
  const driveLink = project.driveFolderId
    ? `<a class="button secondary" href="${escapeHtml(driveFolderUrl(project.driveFolderId))}" target="_blank" rel="noopener">Google Drive</a>`
    : `<button class="button secondary" type="button" disabled>Google Drive</button>`;
  const deleteProjectControl =
    project.role === "owner"
      ? `<div class="full danger-zone">
        <h3>プロジェクト削除</h3>
        <div class="subtle">このプロジェクト、Drive フォルダ、公開 cache を削除します。</div>
        <div class="row"><button class="button danger" id="delete-project" type="button">プロジェクトを削除</button><div id="delete-project-status" class="status" aria-live="polite"></div></div>
      </div>`
      : "";
  return shell(
    user,
    `<nav class="crumbs"><a href="/">ダッシュボード</a><span>›</span><span>${escapeHtml(project.title)}</span></nav>
<div class="title-row">
  <div class="title-stack">
    <h1>${escapeHtml(project.title)}</h1>
    <div class="row" style="align-items:center"><span class="mono muted">${escapeHtml(previewUrl)}</span>${visibilityBadge(project.visibility)}${roleBadge(project.role ?? "viewer")}</div>
  </div>
  <div class="row" style="justify-content:flex-end; align-items:center">
    ${driveLink}
    <a class="button secondary" href="${escapeHtml(previewUrl)}" target="_blank" rel="noopener">Open</a>
  </div>
</div>
<div class="tabs" role="tablist">
  <button class="tab" type="button" role="tab" aria-selected="true" data-tab="files">ファイル</button>
  <button class="tab" type="button" role="tab" aria-selected="false" data-tab="settings">設定</button>
  <button class="tab" type="button" role="tab" aria-selected="false" data-tab="members">メンバー</button>
  <button class="tab" type="button" role="tab" aria-selected="false" data-tab="history">デプロイ履歴</button>
  <button class="tab" type="button" role="tab" aria-selected="false" data-tab="comments">コメント履歴</button>
  <button class="tab" type="button" role="tab" aria-selected="false" data-tab="access">アクセス履歴</button>
</div>
<section class="tab-panel active" id="panel-files" data-project-id="${escapeHtml(project.id)}">
  <div class="panel stack">
    <div class="row"><h2 style="flex:1">ファイル</h2><button class="button" type="button" onclick="document.getElementById('html-file').click()">ファイルをアップロード</button><button class="button secondary" type="button" onclick="document.getElementById('zip-file').click()">ZIP をアップロード</button></div>
    <form id="deploy-form" class="row">
      <input id="html-file" name="file" type="file" accept=".html,text/html" required>
      <input id="zip-file" name="zip" type="file" accept=".zip,application/zip" hidden>
      <button class="button" type="submit">Deploy</button>
      <div id="deploy-status" class="status" aria-live="polite"></div>
    </form>
    <table><thead><tr><th>ファイル名</th><th class="right">サイズ</th><th class="right">更新日時</th><th></th></tr></thead><tbody>${fileRows(project.id, files)}</tbody></table>
  </div>
</section>
<section class="tab-panel" id="panel-settings">
  <form id="settings-form" class="panel form-grid">
    <h2 class="full">設定</h2>
    <label>プロジェクト名<input name="title" value="${escapeHtml(project.title)}" required></label>
    <label>Alias<input class="mono" name="alias" value="${escapeHtml(project.alias)}" data-original-alias="${escapeHtml(project.alias)}" required></label>
    <div class="full status" id="alias-warning"></div>
    <label>公開設定
      <select name="visibility">
        ${["private", "invite", "domain", "link", "public"].map((value) => `<option value="${value}"${project.visibility === value ? " selected" : ""}>${value}</option>`).join("")}
        <option value="group" disabled>group 近日対応</option>
      </select>
    </label>
    <label>カスタムドメイン<input placeholder="例: reports.example.com" disabled></label>
    <div class="full row"><button class="button" type="submit">保存</button><div id="settings-status" class="status" aria-live="polite"></div></div>
    ${deleteProjectControl}
  </form>
</section>
<section class="tab-panel" id="panel-members">
  <div class="panel stack">
    <h2>メンバー</h2>
    <form id="member-form" class="row">
      <label>メールアドレス<input name="email" type="email" required></label>
      <button class="button" type="submit">追加</button>
      <div id="member-status" class="status" aria-live="polite"></div>
    </form>
    <table><thead><tr><th>メンバー</th><th>ロール</th><th>追加日</th><th></th></tr></thead><tbody>${memberRows(members)}</tbody></table>
  </div>
</section>
<section class="tab-panel" id="panel-history">
  <div class="panel stack">
    <h2>デプロイ履歴</h2>
    <table><thead><tr><th>ファイル/種別</th><th>実行者</th><th class="right">サイズ</th><th class="right">デプロイ日時</th></tr></thead><tbody>${deployHistoryRows(deployEvents)}</tbody></table>
  </div>
</section>
<section class="tab-panel" id="panel-comments">
  <div class="panel stack">
    <div class="row comment-history-tools">
      <h2>コメント履歴</h2>
      <label>状態
        <select id="comment-history-status" aria-label="コメント履歴の状態">
          <option value="all">すべて</option>
          <option value="open">未解決</option>
          <option value="resolved">解決済み</option>
        </select>
      </label>
    </div>
    <div class="comment-history-list" id="comment-history-body" aria-live="polite"><div class="empty">タブを選択すると読み込みます</div></div>
    <div class="row" style="justify-content:center">
      <button class="button secondary" id="load-more-comments" type="button" hidden>もっと読み込む</button>
    </div>
  </div>
</section>
<section class="tab-panel" id="panel-access">
  <div class="panel stack">
    <h2>アクセス履歴</h2>
    <table>
      <thead><tr><th>ユーザー</th><th class="right">日時</th></tr></thead>
      <tbody id="access-log-body"><tr><td colspan="2" class="empty">タブを選択すると読み込みます</td></tr></tbody>
    </table>
    <div class="row" style="justify-content:center">
      <button class="button secondary" id="load-more-access" type="button" hidden>もっと読み込む</button>
    </div>
  </div>
</section>
<script>
${projectDetailScript(project.id, project.alias)}
</script>`
  );
}

/**
 * Relies on qs/qsa/setStatus/errorText installed by clientBaseScript().
 * page() must evaluate clientBaseScript in <head> before this script runs.
 */
function projectDetailScript(projectId: string, currentAlias: string): string {
  return `
const projectId = ${safeJsonForScript(projectId)};
const originalAlias = ${safeJsonForScript(currentAlias)};
function activateTab(tabName, updateHash) {
  const nextTab = qs('.tab[data-tab="' + tabName + '"]') || qs('.tab[data-tab="files"]');
  const nextName = nextTab?.dataset.tab || "files";
  qsa(".tab").forEach((item) => item.setAttribute("aria-selected", String(item === nextTab)));
  qsa(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === "panel-" + nextName));
  if (updateHash) history.replaceState(null, "", "#" + nextName);
}
function reloadToTab(tabName) {
  location.hash = tabName;
  location.reload();
}
qsa(".tab").forEach((tab) => tab.addEventListener("click", () => activateTab(tab.dataset.tab || "files", true)));
activateTab(location.hash.replace("#", "") || "files", false);
const aliasInput = qs('input[name="alias"]');
aliasInput?.addEventListener("input", () => {
  const warning = qs("#alias-warning");
  const next = aliasInput.value.trim();
  warning.textContent = next && next !== originalAlias ? "URL が変わります: /" + originalAlias + " → /" + next : "";
  warning.className = warning.textContent ? "status error" : "status";
});
qs("#deploy-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = qs("#html-file").files[0];
  const status = qs("#deploy-status");
  if (!file) return;
  setStatus(status, "Deploying...");
  const response = await fetch("/api/v1/projects/" + encodeURIComponent(projectId) + "/deploy?path=index.html", { method: "POST", headers: { "Content-Type": file.type || "text/html" }, body: await file.arrayBuffer() });
  const payload = await response.json().catch(() => null);
  if (!response.ok) { setStatus(status, errorText(payload, "Deploy failed"), "error"); return; }
  setStatus(status, "Deployed", "ok");
  location.reload();
});
qs("#zip-file")?.addEventListener("change", async (event) => {
  const file = event.currentTarget.files[0];
  const status = qs("#deploy-status");
  if (!file) return;
  setStatus(status, "Deploying ZIP...");
  const response = await fetch("/api/v1/projects/" + encodeURIComponent(projectId) + "/deploy?name=" + encodeURIComponent(file.name || "site.zip"), { method: "POST", headers: { "Content-Type": file.type || "application/zip" }, body: await file.arrayBuffer() });
  const payload = await response.json().catch(() => null);
  if (!response.ok) { setStatus(status, errorText(payload, "ZIP deploy failed"), "error"); event.currentTarget.value = ""; return; }
  setStatus(status, "ZIP deployed: " + payload.files + " files", "ok");
  location.reload();
});
qs("#settings-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = qs("#settings-status");
  const data = new FormData(event.currentTarget);
  setStatus(status, "Saving...");
  const response = await fetch("/api/v1/projects/" + encodeURIComponent(projectId), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: String(data.get("title") || ""), alias: String(data.get("alias") || ""), visibility: String(data.get("visibility") || "domain") }) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) { setStatus(status, errorText(payload, "Save failed"), "error"); return; }
  location.href = "/projects/" + encodeURIComponent(projectId);
});
qs("#member-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = qs("#member-status");
  const data = new FormData(event.currentTarget);
  setStatus(status, "Adding...");
  const response = await fetch("/api/v1/projects/" + encodeURIComponent(projectId) + "/members", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: String(data.get("email") || ""), role: "editor" }) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) { setStatus(status, errorText(payload, "Add failed"), "error"); return; }
  reloadToTab("members");
});
qsa(".member-role").forEach((select) => select.addEventListener("change", async () => {
  const row = select.closest("[data-member-user-id]");
  if (!row) return;
  await fetch("/api/v1/projects/" + encodeURIComponent(projectId) + "/members/" + encodeURIComponent(row.dataset.memberUserId), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: select.value }) });
  reloadToTab("members");
}));
qsa(".remove-member").forEach((button) => button.addEventListener("click", async () => {
  const row = button.closest("[data-member-user-id]");
  if (!row) return;
  await fetch("/api/v1/projects/" + encodeURIComponent(projectId) + "/members/" + encodeURIComponent(row.dataset.memberUserId), { method: "DELETE" });
  reloadToTab("members");
}));
qsa(".remove-file").forEach((button) => button.addEventListener("click", async () => {
  const row = button.closest("[data-file-path]");
  if (!row) return;
  const path = row.dataset.filePath;
  if (!path || !confirm("このファイルを削除しますか?")) return;
  button.disabled = true;
  const response = await fetch("/api/v1/projects/" + encodeURIComponent(projectId) + "/files?path=" + encodeURIComponent(path), { method: "DELETE" });
  if (!response.ok) {
    button.disabled = false;
    alert("Delete failed");
    return;
  }
  location.reload();
}));
let accessCursor = null;
let accessLoaded = false;
let commentHistoryCursor = null;
let commentHistoryLoaded = false;
function formatUtcDateTime(value) {
  const date = new Date(String(value || "") + "Z");
  return Number.isNaN(date.getTime())
    ? "unknown"
    : date.toLocaleDateString("ja-JP") + " " + date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}
function appendAccessLogRow(tbody, log) {
  const tr = document.createElement("tr");
  const userCell = document.createElement("td");
  if (log.userEmail) {
    userCell.appendChild(userIdentityNode(log.userName, log.userEmail, log.userAvatarUrl));
  } else {
    const anonymous = document.createElement("span");
    anonymous.className = "muted";
    anonymous.textContent = "匿名";
    userCell.appendChild(anonymous);
  }
  const dateCell = document.createElement("td");
  dateCell.className = "right mono";
  dateCell.textContent = formatUtcDateTime(log.accessedAt);
  tr.append(userCell, dateCell);
  tbody.appendChild(tr);
}
function commentReviewUrl(thread) {
  return "/projects/" + encodeURIComponent(projectId) + "/review?path=" + encodeURIComponent(thread.path || "index.html") + "#comment-" + encodeURIComponent(thread.id);
}
function authorLabel(author) {
  return author?.name || author?.email || "unknown";
}
function statusLabel(status) {
  return status === "resolved" ? "解決済み" : "未解決";
}
function commentEventText(event) {
  if (event.kind === "comment_created") return "コメントを追加";
  if (event.kind === "reply_created") return "返信を追加";
  if (event.kind === "comment_updated") return "コメント本文を更新";
  if (event.kind === "status_changed") return "ステータスを " + statusLabel(event.previousStatus) + " から " + statusLabel(event.nextStatus) + " に変更";
  if (event.kind === "current_status") return "現在の状態は " + statusLabel(event.nextStatus);
  return "コメントを更新";
}
function sortCommentEventsForDisplay(events) {
  return [...events].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || String(b.id || "").localeCompare(String(a.id || "")));
}
function appendCommentHistoryEvents(item, thread) {
  const events = Array.isArray(thread.events) ? sortCommentEventsForDisplay(thread.events) : [];
  if (!events.length) return;
  const list = document.createElement("ol");
  list.className = "comment-history-events";
  for (const event of events) {
    const row = document.createElement("li");
    row.className = "comment-history-event";
    const time = document.createElement("span");
    time.className = "mono comment-history-event-time";
    time.textContent = formatUtcDateTime(event.createdAt);
    const body = document.createElement("span");
    body.className = "comment-history-event-body";
    body.textContent = authorLabel(event.actor) + " が " + commentEventText(event);
    if (event.inferred && event.kind === "current_status") {
      const note = document.createElement("span");
      note.className = "comment-history-event-note";
      note.textContent = "履歴記録前のため、変更者は推定表示です";
      body.appendChild(document.createTextNode(" "));
      body.appendChild(note);
    }
    row.append(time, body);
    list.appendChild(row);
  }
  item.appendChild(list);
}
function appendCommentHistoryItem(list, thread) {
  const item = document.createElement("article");
  const url = commentReviewUrl(thread);
  item.className = "review-card comment-history-item";
  item.tabIndex = 0;
  item.addEventListener("click", (event) => {
    if (event.target?.closest?.("a, button, input, select, textarea")) return;
    location.href = url;
  });
  item.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    location.href = url;
  });
  const head = document.createElement("div");
  head.className = "comment-history-head";
  const main = document.createElement("div");
  main.className = "comment-history-main";
  const link = document.createElement("a");
  link.className = "comment-history-link";
  link.href = url;
  link.textContent = thread.body || "本文なし";
  const quote = document.createElement("blockquote");
  quote.className = "review-quote comment-history-quote";
  quote.textContent = thread.selectedText || thread.anchor?.selectedText || "位置未確定";
  main.append(link, quote);
  const status = document.createElement("span");
  status.className = "review-status" + (thread.status === "resolved" ? " resolved" : "");
  const replies = Array.isArray(thread.replies) ? thread.replies.length : 0;
  status.textContent = (thread.status === "resolved" ? "解決済み" : "未解決") + (replies ? " / 返信 " + replies : "");
  head.append(main, status);
  const meta = document.createElement("div");
  meta.className = "comment-history-meta";
  const path = document.createElement("span");
  path.className = "mono comment-history-path";
  path.title = thread.path || "";
  path.textContent = thread.path || "index.html";
  const author = document.createElement("span");
  author.appendChild(userIdentityNode(thread.author?.name, thread.author?.email, thread.author?.avatarUrl));
  const updated = document.createElement("span");
  updated.className = "mono";
  updated.textContent = formatUtcDateTime(thread.updatedAt);
  meta.append(path, author, updated);
  item.append(head, meta);
  appendCommentHistoryEvents(item, thread);
  list.appendChild(item);
}
async function loadAccessLogs(append) {
  if (append && !accessCursor) return;
  let url = "/api/v1/projects/" + encodeURIComponent(projectId) + "/access-logs?limit=50";
  if (accessCursor) url += "&cursor=" + encodeURIComponent(accessCursor);
  const tbody = qs("#access-log-body");
  const loadMore = qs("#load-more-access");
  if (!tbody) return;
  const response = await fetch(url);
  if (!response.ok) return;
  const data = await response.json();
  if (!append) tbody.innerHTML = "";
  if (!data.logs.length) {
    if (loadMore) loadMore.hidden = true;
    if (!append) {
      tbody.innerHTML = '<tr><td colspan="2" class="empty">アクセス記録はありません</td></tr>';
    }
    return;
  }
  for (const log of data.logs) {
    appendAccessLogRow(tbody, log);
  }
  accessCursor = data.nextCursor;
  if (loadMore) loadMore.hidden = !data.nextCursor;
}
async function loadCommentHistory(append) {
  if (append && !commentHistoryCursor) return;
  if (!append) commentHistoryCursor = null;
  const list = qs("#comment-history-body");
  const loadMore = qs("#load-more-comments");
  if (!list) return;
  if (!append) list.innerHTML = '<div class="empty">読み込み中...</div>';
  let url = "/api/v1/projects/" + encodeURIComponent(projectId) + "/comment-threads?limit=50&status=" + encodeURIComponent(qs("#comment-history-status")?.value || "all");
  if (commentHistoryCursor) url += "&cursor=" + encodeURIComponent(commentHistoryCursor);
  const response = await fetch(url);
  if (!response.ok) {
    if (loadMore) loadMore.hidden = true;
    if (!append) list.innerHTML = '<div class="empty">コメント履歴を読み込めません</div>';
    return;
  }
  const data = await response.json();
  if (!append) list.innerHTML = "";
  if (!data.threads.length) {
    if (loadMore) loadMore.hidden = true;
    if (!append) list.innerHTML = '<div class="empty">コメントはありません</div>';
    return;
  }
  for (const thread of data.threads) {
    appendCommentHistoryItem(list, thread);
  }
  commentHistoryCursor = data.nextCursor;
  if (loadMore) loadMore.hidden = !data.nextCursor;
}
const baseActivateTab = activateTab;
activateTab = function(tabName, updateHash) {
  baseActivateTab(tabName, updateHash);
  if (tabName === "comments" && !commentHistoryLoaded) {
    commentHistoryLoaded = true;
    loadCommentHistory(false);
  }
  if (tabName === "access" && !accessLoaded) {
    accessLoaded = true;
    loadAccessLogs(false);
  }
};
qs("#comment-history-status")?.addEventListener("change", () => {
  commentHistoryLoaded = true;
  loadCommentHistory(false);
});
qs("#load-more-comments")?.addEventListener("click", () => loadCommentHistory(true));
qs("#load-more-access")?.addEventListener("click", () => loadAccessLogs(true));
if ((location.hash.replace("#", "") || "files") === "comments") {
  commentHistoryLoaded = true;
  loadCommentHistory(false);
}
if ((location.hash.replace("#", "") || "files") === "access") {
  accessLoaded = true;
  loadAccessLogs(false);
}
qs("#delete-project")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const status = qs("#delete-project-status");
  if (!confirm("このプロジェクトを削除しますか?")) return;
  button.disabled = true;
  setStatus(status, "Deleting...");
  const response = await fetch("/api/v1/projects/" + encodeURIComponent(projectId), { method: "DELETE" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    button.disabled = false;
    setStatus(status, errorText(payload, "Delete failed"), "error");
    return;
  }
  location.href = "/";
});
`;
}

export async function projectDetail(c: Context<AppBindings>): Promise<Response> {
  const user = c.get("user") ?? null;
  if (!user) {
    return c.redirect("/auth/login", 302);
  }
  const projectId = c.req.param("id");
  if (!projectId) {
    return c.notFound();
  }
  const project = await getProjectForUser(c.env, projectId, user.id);
  if (!project) {
    return c.notFound();
  }
  const [members, files, deployEvents] = await Promise.all([
    listProjectMembers(c.env, project.id),
    listProjectFilesWithDeployers(c.env, project.id),
    listDeployEventsWithDeployers(c.env, project.id)
  ]);
  return c.html(page(`${project.title} - publicar`, projectDetailPage(user, project, members, files, deployEvents)));
}
