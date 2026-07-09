import { listProjectsForUser, type Project } from "../../db/projects";
import type { AppBindings, AuthUser } from "../../env";
import type { Context } from "hono";
import { escapeHtml, firstAllowedDomain, googleIcon, iconGrid, iconList, loginPage, page, roleBadge, shell, visibilityBadge } from "./layout";

function projectCard(project: Project): string {
  return `<article class="card project-card" data-project-title="${escapeHtml(project.title.toLowerCase())}" data-project-alias="${escapeHtml(project.alias.toLowerCase())}">
  <div class="card-head">
    <div class="stack" style="gap:7px">
      <h3>${escapeHtml(project.title)}</h3>
      <div class="mono muted">/${escapeHtml(project.alias)}</div>
      <div class="badges">${visibilityBadge(project.visibility)}${roleBadge(project.role ?? "viewer")}</div>
    </div>
    <a class="button secondary" href="/projects/${encodeURIComponent(project.id)}">詳細</a>
  </div>
  <div class="meta-row">
    <span>entry: <span class="mono">${escapeHtml(project.entryPath)}</span></span>
    <a href="/${encodeURIComponent(project.alias)}/" target="_blank" rel="noopener">開く</a>
  </div>
</article>`;
}

function projectListRows(projects: Project[]): string {
  if (!projects.length) {
    return `<tr><td colspan="5" class="empty">No projects</td></tr>`;
  }
  return projects
    .map(
      (project) => `<tr class="project-row" data-project-title="${escapeHtml(project.title.toLowerCase())}" data-project-alias="${escapeHtml(project.alias.toLowerCase())}">
  <td><a href="/projects/${encodeURIComponent(project.id)}">${escapeHtml(project.title)}</a></td>
  <td class="mono">/${escapeHtml(project.alias)}</td>
  <td>${visibilityBadge(project.visibility)}</td>
  <td>${roleBadge(project.role ?? "viewer")}</td>
  <td class="right"><a href="/${encodeURIComponent(project.alias)}/" target="_blank" rel="noopener">開く</a></td>
</tr>`
    )
    .join("");
}

function dashboard(user: AuthUser, projects: Project[]): string {
  return shell(
    user,
    `<div class="toolbar">
  <div class="search">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>
    <input id="project-search" placeholder="プロジェクトを検索..." autocomplete="off">
  </div>
  <div class="segmented" role="group" aria-label="表示モード">
    <button type="button" data-view-mode="grid" aria-pressed="true" aria-label="カード表示" title="カード表示">${iconGrid()}</button>
    <button type="button" data-view-mode="list" aria-pressed="false" aria-label="リスト表示" title="リスト表示">${iconList()}</button>
  </div>
  <button class="button" type="button" data-open-modal="#new-project-dialog">+ 新規プロジェクト</button>
</div>
<section class="grid" id="project-grid">${projects.map(projectCard).join("") || '<div class="empty">No projects</div>'}</section>
<section class="project-list panel" id="project-list" hidden>
  <table><thead><tr><th>プロジェクト</th><th>URL</th><th>公開設定</th><th>ロール</th><th></th></tr></thead><tbody>${projectListRows(projects)}</tbody></table>
</section>
<dialog id="new-project-dialog">
  <form class="modal-body" id="create-project">
    <h2>新規プロジェクト</h2>
    <label>プロジェクト名<input name="title" autocomplete="off" required></label>
    <label>Alias<input class="mono" name="alias" autocomplete="off" pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,63}" placeholder="未入力なら自動生成"></label>
    <label>公開設定
      <select name="visibility">
        <option value="domain">domain</option>
        <option value="private">private</option>
        <option value="invite">invite</option>
        <option value="link">link</option>
        <option value="public">public</option>
        <option value="group" disabled>group 近日対応</option>
      </select>
    </label>
    <div class="row"><button class="button" type="submit">作成</button><button class="button secondary" type="button" data-close-modal>キャンセル</button></div>
    <div id="create-status" class="status" aria-live="polite"></div>
  </form>
</dialog>
<script>
${dashboardScript()}
</script>`
  );
}

function dashboardScript(): string {
  return `
function setProjectViewMode(mode) {
  const isList = mode === "list";
  qs("#project-grid").hidden = isList;
  qs("#project-list").hidden = !isList;
  qsa("[data-view-mode]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.viewMode === mode)));
  localStorage.setItem("publicar-project-view", mode);
}
qs("#project-search")?.addEventListener("input", (event) => {
  const query = event.target.value.trim().toLowerCase();
  qsa(".project-card, .project-row").forEach((item) => {
    const haystack = (item.dataset.projectTitle || "") + " " + (item.dataset.projectAlias || "");
    item.style.display = haystack.includes(query) ? "" : "none";
  });
});
qsa("[data-view-mode]").forEach((button) => button.addEventListener("click", () => setProjectViewMode(button.dataset.viewMode || "grid")));
setProjectViewMode(localStorage.getItem("publicar-project-view") === "list" ? "list" : "grid");
qs("#create-project")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const status = qs("#create-status");
  setStatus(status, "Creating...");
  const data = new FormData(form);
  const body = { title: String(data.get("title") || ""), visibility: String(data.get("visibility") || "domain") };
  const alias = String(data.get("alias") || "").trim();
  if (alias) body.alias = alias;
  const response = await fetch("/api/v1/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) { setStatus(status, errorText(payload, "Create failed"), "error"); return; }
  location.href = "/projects/" + encodeURIComponent(payload.project.id);
});
`;
}

export async function home(c: Context<AppBindings>): Promise<Response> {
  const user = c.get("user") ?? null;
  if (!user) {
    return c.html(loginPage(firstAllowedDomain(c)));
  }
  const projects = await listProjectsForUser(c.env, user.id);
  return c.html(page("publicar", dashboard(user, projects)));
}

