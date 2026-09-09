import { canViewProject, getProjectById, normalizeFilePath, type Project } from "../../db/projects";
import type { AppBindings, AuthUser } from "../../env";
import type { Context } from "hono";
import { escapeHtml, page, shell } from "./layout";

function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function projectReviewPage(user: AuthUser, project: Project, path: string): string {
  const reviewFileUrl = projectFileUrl(project, path, "__publicar_review=1");
  return shell(
    user,
    `<div class="review-shell">
  <div class="review-topbar">
    <div class="title-stack">
      <nav class="crumbs" style="margin-bottom:4px"><a href="/">ダッシュボード</a><span>›</span><a href="/projects/${encodeURIComponent(project.id)}">${escapeHtml(project.title)}</a><span>›</span><span>レビュー</span></nav>
      <h1>${escapeHtml(project.title)}</h1>
      <div class="mono muted">${escapeHtml(path)}</div>
    </div>
    <div class="row"><a class="button secondary" href="/${encodeURIComponent(project.alias)}/" target="_blank" rel="noopener">Open</a><a class="button secondary" href="/projects/${encodeURIComponent(project.id)}">詳細</a></div>
  </div>
  <div class="review-layout">
    <div class="review-frame-wrap"><iframe class="review-frame" id="review-frame" src="about:blank" data-review-src="${escapeHtml(reviewFileUrl)}" title="レビュー対象HTML"></iframe></div>
    <aside class="review-rail" aria-label="コメント">
      <div class="review-rail-head">
        <span class="review-rail-title">コメント <span class="muted" id="review-count">0</span></span>
        <span class="review-rail-tools"><select id="comment-status-filter" aria-label="コメントフィルタ"><option value="open">未解決</option><option value="all">すべて</option><option value="resolved">解決済み</option></select></span>
      </div>
      <div class="review-comments" id="review-comments"><div class="empty">読み込み中...</div></div>
    </aside>
  </div>
  <div class="comment-toolbar" id="comment-toolbar"><button class="button" type="button" id="open-comment-composer">コメント</button></div>
  <div class="comment-popover comment-composer" id="comment-popover">
    <textarea id="comment-body" placeholder="コメントを入力..."></textarea>
    <div class="comment-popover-foot"><span class="comment-shortcut">⌘+Enter</span><span class="comment-popover-actions"><button class="button secondary" type="button" id="cancel-comment">取消</button><button class="button" type="button" id="save-comment" disabled>送信</button></span></div>
    <div class="status" id="comment-status" aria-live="polite"></div>
  </div>
</div>
<script>
${reviewScript(project.id, path)}
</script>`
  , { mainClass: "full-bleed" });
}

function projectFileUrl(project: Project, path: string, query?: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const suffix = query ? `?${query}` : "";
  return `/${encodeURIComponent(project.alias)}/${encodedPath}${suffix}`;
}

export function commentWorkbenchPage(user: AuthUser, project: Project, path: string): string {
  const reviewFileUrl = projectFileUrl(project, path, "__publicar_review=1");
  const commentIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`;
  const headerControls = `<button class="comment-mode-button" type="button" data-comment-mode-toggle aria-pressed="false">${commentIcon}<span>コメント</span></button>`;
  return page(
    `${project.title} - publicar`,
    shell(
      user,
      `<div class="comment-workbench" data-comment-workbench>
  <iframe class="comment-workbench-frame" id="review-frame" src="about:blank" data-review-src="${escapeHtml(reviewFileUrl)}" title="${escapeHtml(project.title)}"></iframe>
  <aside class="review-rail" aria-label="コメント">
    <div class="review-rail-head">
      <span class="review-rail-title">コメント <span class="muted" id="review-count">0</span></span>
      <span class="review-rail-tools"><select id="comment-status-filter" aria-label="コメントフィルタ"><option value="open">未解決</option><option value="all">すべて</option><option value="resolved">解決済み</option></select><button class="review-close" type="button" data-close-review-rail aria-label="コメントを閉じる">×</button></span>
    </div>
    <div class="review-comments" id="review-comments"><div class="empty">コメントモードを有効にしてください</div></div>
  </aside>
  <div class="comment-toolbar" id="comment-toolbar"><button class="button" type="button" id="open-comment-composer">コメント</button></div>
  <div class="comment-popover comment-composer" id="comment-popover">
    <textarea id="comment-body" placeholder="コメントを入力..."></textarea>
    <div class="comment-popover-foot"><span class="comment-shortcut">⌘+Enter</span><span class="comment-popover-actions"><button class="button secondary" type="button" id="cancel-comment">取消</button><button class="button" type="button" id="save-comment" disabled>送信</button></span></div>
    <div class="status" id="comment-status" aria-live="polite"></div>
  </div>
</div>
<script>
${reviewScript(project.id, path)}
</script>`,
      { mainClass: "full-bleed", headerControls }
    )
  );
}

/**
 * Relies on qs/qsa/setStatus/errorText installed by clientBaseScript().
 * page() must evaluate clientBaseScript in <head> before this script runs.
 */
function reviewScript(projectId: string, path: string): string {
  return `
const reviewProjectId = ${safeJsonForScript(projectId)};
const reviewPath = ${safeJsonForScript(path)};
const frame = qs("#review-frame");
const commentsRoot = qs("#review-comments");
const countLabel = qs("#review-count");
const toolbar = qs("#comment-toolbar");
const popover = qs("#comment-popover");
const commentBody = qs("#comment-body");
const saveCommentButton = qs("#save-comment");
const commentStatus = qs("#comment-status");
const workbench = qs("[data-comment-workbench]");
const modeButton = qs("[data-comment-mode-toggle]");
let reviewDoc = null;
let comments = [];
let selected = null;
let activeCommentId = null;
let reviewBlockIndex = 0;
let syncingFrameHash = false;
let frameHashPoll = null;
let commentComposerTimer = null;
let highlightObserver = null;
let routeHighlightTimer = null;
let suppressHighlightObserver = false;
let parentRoutePriorityUntil = 0;
let frameRoutePriorityUntil = 0;
let lastObservedFrameHash = "";
let lastObservedParentHash = "";
const lastActiveCommentByFrameHash = new Map();
const COMMENT_COMPOSER_DELAY_MS = 360;
const FRAME_HASH_SYNC_DELAYS_MS = [0, 50, 200, 600, 1200];

function apiBase() {
  return "/api/v1/projects/" + encodeURIComponent(reviewProjectId);
}
function escapeText(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
function authorName(author) {
  return author?.name || author?.email || "unknown";
}
function authorInitial(author) {
  return authorName(author).slice(0, 1).toUpperCase();
}
function actorKindBadge(actorKind) {
  return actorKind === "ai" ? '<span class="comment-actor-ai" title="AI 経由で回答">🤖 AI</span>' : "";
}
function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function commentModeEnabled() {
  return !workbench || workbench.classList.contains("comment-mode");
}
function openCommentsRail() {
  workbench?.classList.add("comment-rail-open");
}
function closeCommentsRail() {
  workbench?.classList.remove("comment-rail-open");
}
function commentsRailOpen() {
  return Boolean(workbench?.classList.contains("comment-rail-open"));
}
function setCommentMode(enabled) {
  if (!workbench || !modeButton) return;
  workbench.classList.toggle("comment-mode", enabled);
  modeButton.setAttribute("aria-pressed", enabled ? "true" : "false");
  const label = modeButton.querySelector("span");
  if (label) label.textContent = enabled ? "コメント中" : "コメント";
  toolbar.classList.remove("open");
  popover.classList.remove("open");
  if (!enabled) {
    closeCommentsRail();
    clearHighlights();
    commentsRoot.innerHTML = '<div class="empty">コメントモードを有効にしてください</div>';
    countLabel.textContent = "0";
  }
  if (enabled) loadComments();
}
function handleCommentModeToggle() {
  if (!commentModeEnabled()) {
    setCommentMode(true);
    openCommentsRail();
    return;
  }
  setCommentMode(false);
}
function installReviewStyles() {
  if (!reviewDoc || reviewDoc.getElementById("publicar-review-style")) return;
  const style = reviewDoc.createElement("style");
  style.id = "publicar-review-style";
  style.textContent = ".publicar-cx{background:var(--highlight,rgba(210,153,34,.18));border-bottom:2px solid var(--highlight-border,rgba(210,153,34,.5));cursor:pointer;transition:background .2s ease}.publicar-cx:hover{background:rgba(210,153,34,.12)}.publicar-cx[data-status='resolved']{background:transparent;border-bottom:1px dashed var(--green,#22c55e)}.publicar-cx.active{background:var(--highlight-active,rgba(210,153,34,.35));outline:2px solid var(--accent,#3b82f6);outline-offset:2px}";
  if (workbench) {
    style.textContent += "html,body{width:100%!important;max-width:none!important}body{margin-left:0!important;margin-right:0!important}body>*,#root,#app,#__next,.app,.app-shell,.page,.page-shell,.layout,.content,.main,.container,.workspace,.schema-browser,.schema-layout,.registry-layout{max-width:none!important;width:100%!important;margin-left:0!important;margin-right:0!important}";
  }
  (reviewDoc.head || reviewDoc.documentElement).appendChild(style);
}
function frameRectFor(rect) {
  const frameRect = frame.getBoundingClientRect();
  return {
    top: frameRect.top + rect.top,
    bottom: frameRect.top + rect.bottom,
    left: frameRect.left + rect.left,
    right: frameRect.left + rect.right,
    width: rect.width,
    height: rect.height
  };
}
function positionFloating(el, rect, below) {
  const margin = 8;
  el.style.visibility = "hidden";
  el.classList.add("open");
  const width = el.offsetWidth || 280;
  const height = el.offsetHeight || 44;
  const left = Math.min(window.innerWidth - width - 12, Math.max(12, rect.left + rect.width / 2 - width / 2));
  let top = below ? rect.bottom + margin : rect.top - height - margin;
  if (top < 12) top = rect.bottom + margin;
  if (top + height > window.innerHeight - 12) top = Math.max(12, rect.top - height - margin);
  el.style.left = left + "px";
  el.style.top = top + "px";
  el.style.visibility = "";
}
function clearCommentComposerTimer() {
  if (commentComposerTimer !== null) {
    window.clearTimeout(commentComposerTimer);
    commentComposerTimer = null;
  }
}
function clearSelectionDraft() {
  selected = null;
  clearCommentComposerTimer();
  toolbar.classList.remove("open");
  if (!popover.contains(document.activeElement)) popover.classList.remove("open");
}
function clearActiveCommentSelection() {
  activeCommentId = null;
  if (routeHighlightTimer !== null) {
    window.clearTimeout(routeHighlightTimer);
    routeHighlightTimer = null;
  }
  qsa(".review-card.active").forEach((card) => card.classList.remove("active"));
  reviewDoc?.querySelectorAll(".publicar-cx.active").forEach((el) => el.classList.remove("active"));
}
function rememberActiveComment(thread) {
  const hash = threadFrameHash(thread);
  if (isFrameRouteHash(hash)) lastActiveCommentByFrameHash.set(hash, thread.id);
}
function setActiveCommentSelection(thread, scrollCard) {
  activeCommentId = thread.id;
  qsa(".review-card.active").forEach((card) => card.classList.remove("active"));
  const card = qs('[data-comment-card="' + CSS.escape(thread.id) + '"]');
  card?.classList.add("active");
  setActiveHighlight(thread.id);
  if (scrollCard) card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function restoreActiveCommentForRoute(hash, scrollCard = false) {
  if (!isFrameRouteHash(hash)) {
    clearActiveCommentSelection();
    return false;
  }
  if (activeCommentMatchesRouteHash(hash)) return true;
  const rememberedId = lastActiveCommentByFrameHash.get(hash);
  const thread = (rememberedId ? comments.find((item) => item.id === rememberedId && threadFrameHash(item) === hash) : null)
    || comments.find((item) => threadFrameHash(item) === hash);
  if (!thread) {
    clearActiveCommentSelection();
    return false;
  }
  clearActiveCommentSelection();
  setActiveCommentSelection(thread, scrollCard);
  return true;
}
function scheduleCommentComposer(rect) {
  clearCommentComposerTimer();
  toolbar.classList.remove("open");
  popover.classList.remove("open");
  commentComposerTimer = window.setTimeout(() => {
    commentComposerTimer = null;
    if (!selected) return;
    positionFloating(popover, rect, true);
    commentBody.focus();
  }, COMMENT_COMPOSER_DELAY_MS);
}
function ensureReviewBlocks() {
  if (!reviewDoc) return;
  const candidates = reviewDoc.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,td,th,pre,blockquote,figcaption,summary,dd,dt");
  candidates.forEach((node) => {
    if (!node.hasAttribute("data-review-block") && (node.textContent || "").trim()) {
      reviewBlockIndex += 1;
      node.setAttribute("data-review-block", "auto-" + reviewBlockIndex);
    }
  });
  if (!reviewDoc.querySelector("[data-review-block]") && reviewDoc.body) {
    reviewDoc.body.setAttribute("data-review-block", "body");
  }
}
function assignReviewBlock(element) {
  if (!element || element.hasAttribute("data-review-block") || !(element.textContent || "").trim()) return element;
  reviewBlockIndex += 1;
  element.setAttribute("data-review-block", "auto-" + reviewBlockIndex);
  return element;
}
function closestBlock(node) {
  const element = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  const existing = element?.closest("[data-review-block]");
  if (existing) return existing;
  const candidate = element?.closest("p,h1,h2,h3,h4,h5,h6,li,td,th,pre,blockquote,figcaption,summary,dd,dt,section,article,div");
  return assignReviewBlock(candidate);
}
function textNodesIn(root, includeHighlights = false) {
  const nodes = [];
  const walker = reviewDoc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || (!includeHighlights && node.parentElement?.closest(".publicar-cx"))) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let node = walker.nextNode();
  while (node) {
    nodes.push(node);
    node = walker.nextNode();
  }
  return nodes;
}
function selectionAnchor(block, range) {
  const selectedText = range.toString();
  if (!selectedText.trim()) return null;
  try {
    const beforeRange = range.cloneRange();
    beforeRange.selectNodeContents(block);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const start = beforeRange.toString().length;
    const end = start + selectedText.length;
    const text = block.textContent || "";
    if (end <= start) return null;
    return {
      blockId: block.getAttribute("data-review-block"),
      start,
      end,
      selectedText,
      prefix: text.slice(Math.max(0, start - 48), start),
      suffix: text.slice(end, end + 48),
      blockText: text.slice(0, 500),
      blockTagName: block.tagName
    };
  } catch (_error) {
    // Fall back for unusual Range boundaries.
  }
  const nodes = textNodesIn(block, true);
  let position = 0;
  let start = null;
  let end = null;
  for (const node of nodes) {
    const len = (node.nodeValue || "").length;
    if (node === range.startContainer) start = position + range.startOffset;
    if (node === range.endContainer) end = position + range.endOffset;
    position += len;
  }
  if (start === null || end === null || end <= start) return null;
  const text = block.textContent || "";
  return {
    blockId: block.getAttribute("data-review-block"),
    start,
    end,
    selectedText: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - 48), start),
    suffix: text.slice(end, end + 48),
    blockText: text.slice(0, 500),
    blockTagName: block.tagName
  };
}
function captureSelection() {
  if (!commentModeEnabled()) return;
  if (!reviewDoc) return;
  ensureReviewBlocks();
  const selection = frame.contentWindow?.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    clearSelectionDraft();
    return;
  }
  clearActiveCommentSelection();
  const range = selection.getRangeAt(0);
  const block = closestBlock(range.commonAncestorContainer) || closestBlock(range.startContainer);
  if (!block) return;
  const anchor = selectionAnchor(block, range);
  if (!anchor || !anchor.selectedText.trim()) return;
  selected = anchor;
  const selectionRect = frameRectFor(range.getBoundingClientRect());
  scheduleCommentComposer(selectionRect);
}
function clearHighlights() {
  if (!reviewDoc) return;
  reviewDoc.querySelectorAll(".publicar-cx").forEach((highlight) => {
    const parent = highlight.parentNode;
    while (highlight.firstChild) parent.insertBefore(highlight.firstChild, highlight);
    parent.removeChild(highlight);
    parent.normalize();
  });
}
function wrapSlice(node, start, end, thread) {
  try {
    const range = reviewDoc.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const span = reviewDoc.createElement("span");
    span.className = "publicar-cx";
    span.dataset.comment = thread.id;
    span.dataset.status = thread.status;
    span.addEventListener("click", () => activateComment(thread.id, true));
    range.surroundContents(span);
    return true;
  } catch (_error) {
    return false;
  }
}
function nearbyTextForNode(node) {
  const block = closestBlock(node) || reviewDoc.body;
  return block?.textContent || node.nodeValue || "";
}
function findAnchorInTextNodes(anchor, thread) {
  const selectedText = typeof anchor.selectedText === "string" && anchor.selectedText.trim() ? anchor.selectedText : thread.selectedText || "";
  if (!selectedText.trim() || !reviewDoc.body) return null;
  const prefix = typeof anchor.prefix === "string" && anchor.prefix ? anchor.prefix : thread.prefix || "";
  const suffix = typeof anchor.suffix === "string" && anchor.suffix ? anchor.suffix : thread.suffix || "";
  let fallback = null;
  for (const node of textNodesIn(reviewDoc.body)) {
    const text = node.nodeValue || "";
    let start = text.indexOf(selectedText);
    while (start >= 0) {
      const end = start + selectedText.length;
      const nearby = nearbyTextForNode(node);
      const selectedInNearby = nearby.indexOf(selectedText);
      const prefixMatches = !prefix || nearby.slice(Math.max(0, selectedInNearby - prefix.length), selectedInNearby) === prefix;
      const suffixMatches = !suffix || nearby.slice(selectedInNearby + selectedText.length, selectedInNearby + selectedText.length + suffix.length) === suffix;
      const match = { node, start, end };
      if (selectedInNearby >= 0 && prefixMatches && suffixMatches) return match;
      if (!fallback) fallback = match;
      start = text.indexOf(selectedText, start + 1);
    }
  }
  return fallback;
}
function findAnchorInRenderedText(anchor, thread) {
  const selectedText = typeof anchor.selectedText === "string" && anchor.selectedText.trim() ? anchor.selectedText : thread.selectedText || "";
  if (!selectedText.trim()) return null;
  const prefix = typeof anchor.prefix === "string" && anchor.prefix ? anchor.prefix : thread.prefix || "";
  const suffix = typeof anchor.suffix === "string" && anchor.suffix ? anchor.suffix : thread.suffix || "";
  const expectedBlockText = typeof anchor.blockText === "string" ? anchor.blockText : "";
  const expectedTagName = typeof anchor.blockTagName === "string" ? anchor.blockTagName.toUpperCase() : "";
  const candidates = reviewDoc.querySelectorAll("[data-review-block],p,h1,h2,h3,h4,h5,h6,li,td,th,pre,blockquote,figcaption,summary,dd,dt");
  let best = null;
  let fallback = null;
  let order = 0;
  for (const block of candidates) {
    const text = block.textContent || "";
    let start = text.indexOf(selectedText);
    while (start >= 0) {
      const end = start + selectedText.length;
      const prefixMatches = !prefix || text.slice(Math.max(0, start - prefix.length), start) === prefix;
      const suffixMatches = !suffix || text.slice(end, end + suffix.length) === suffix;
      const match = { block, start, end, order };
      const tagName = block.tagName || "";
      const inNavigation = Boolean(block.closest("nav,aside,header,footer,[role='navigation']"));
      const inInteractive = Boolean(block.closest("a,button,[role='button']"));
      let score = 0;
      if (prefixMatches && suffixMatches) score += 1000;
      if (expectedBlockText && text.slice(0, 500) === expectedBlockText) score += 500;
      if (expectedTagName && tagName === expectedTagName) score += 120;
      if (/^H[1-6]$/.test(tagName)) score += 80;
      if (/^(P|BLOCKQUOTE|PRE|TD|TH|DD|DT|FIGCAPTION)$/.test(tagName)) score += 50;
      if (inNavigation) score -= 250;
      if (inInteractive) score -= 200;
      match.score = score;
      if (prefixMatches && suffixMatches && (!best || score > best.score || (score === best.score && order < best.order))) best = match;
      if (!fallback || score > fallback.score || (score === fallback.score && order < fallback.order)) fallback = match;
      start = text.indexOf(selectedText, start + 1);
    }
    order += 1;
  }
  return best || fallback;
}
function threadFrameHash(thread) {
  return typeof thread?.anchor?.frameHash === "string" ? thread.anchor.frameHash : "";
}
function currentFrameHash() {
  try {
    return frame.contentWindow?.location.hash || "";
  } catch (_error) {
    return "";
  }
}
function selectedTextForAnchor(anchor, thread) {
  return typeof anchor.selectedText === "string" && anchor.selectedText.trim() ? anchor.selectedText : thread.selectedText || "";
}
function anchorHasTextContext(anchor, thread) {
  return Boolean(anchor.prefix || anchor.suffix || thread.prefix || thread.suffix);
}
function storedAnchorMatchesBlock(block, start, end, anchor, thread) {
  if (!block || !Number.isInteger(start) || !Number.isInteger(end) || end <= start) return false;
  const text = block.textContent || "";
  const selectedText = selectedTextForAnchor(anchor, thread);
  const prefix = typeof anchor.prefix === "string" && anchor.prefix ? anchor.prefix : thread.prefix || "";
  const suffix = typeof anchor.suffix === "string" && anchor.suffix ? anchor.suffix : thread.suffix || "";
  if (selectedText && text.slice(start, end) !== selectedText) return false;
  if (prefix && text.slice(Math.max(0, start - prefix.length), start) !== prefix) return false;
  if (suffix && text.slice(end, end + suffix.length) !== suffix) return false;
  return true;
}
function highlightThread(thread) {
  const anchor = thread.anchor || {};
  const frameHash = threadFrameHash(thread);
  if (frameHash && currentFrameHash() !== frameHash) return false;
  const blockId = anchor.blockId;
  let block = blockId ? reviewDoc.querySelector('[data-review-block="' + CSS.escape(String(blockId)) + '"]') : null;
  let start = Number(anchor.start);
  let end = Number(anchor.end);
  const renderedMatch = findAnchorInRenderedText(anchor, thread);
  const textNodeMatch = findAnchorInTextNodes(anchor, thread);
  if (anchorHasTextContext(anchor, thread) && renderedMatch) {
    block = renderedMatch.block;
    start = renderedMatch.start;
    end = renderedMatch.end;
  } else if (!storedAnchorMatchesBlock(block, start, end, anchor, thread)) {
    if (!renderedMatch) {
      return textNodeMatch ? wrapSlice(textNodeMatch.node, textNodeMatch.start, textNodeMatch.end, thread) : false;
    }
    block = renderedMatch.block;
    start = renderedMatch.start;
    end = renderedMatch.end;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return false;
  let pos = 0;
  let done = false;
  for (const node of textNodesIn(block)) {
    const text = node.nodeValue || "";
    const nodeStart = pos;
    const nodeEnd = pos + text.length;
    const overlapStart = Math.max(start, nodeStart);
    const overlapEnd = Math.min(end, nodeEnd);
    pos = nodeEnd;
    if (overlapStart < overlapEnd) {
      done = wrapSlice(node, overlapStart - nodeStart, overlapEnd - nodeStart, thread) || done;
    }
  }
  if (!done && textNodeMatch) {
    done = wrapSlice(textNodeMatch.node, textNodeMatch.start, textNodeMatch.end, thread);
  }
  return done;
}
function renderHighlights() {
  suppressHighlightObserver = true;
  clearHighlights();
  ensureReviewBlocks();
  comments.forEach(highlightThread);
  if (activeCommentId) setActiveHighlight(activeCommentId);
  window.setTimeout(() => {
    suppressHighlightObserver = false;
  }, 0);
}
function renderCurrentRouteHighlights(scrollCard = false) {
  if (!reviewDoc) return false;
  renderHighlights();
  const hash = currentFrameHash();
  return isFrameRouteHash(hash) ? restoreActiveCommentForRoute(hash, scrollCard) : true;
}
function setActiveHighlight(id) {
  reviewDoc?.querySelectorAll(".publicar-cx.active").forEach((el) => el.classList.remove("active"));
  reviewDoc?.querySelectorAll('.publicar-cx[data-comment="' + CSS.escape(id) + '"]').forEach((el) => el.classList.add("active"));
}
function commentHash(id) {
  return "#comment-" + encodeURIComponent(id);
}
function normalizedParentPath(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin !== window.location.origin) return "";
    return parsed.pathname + parsed.search + parsed.hash;
  } catch (_error) {
    return "";
  }
}
function parentUrlForThread(thread) {
  const anchor = thread?.anchor || {};
  const parentUrl = normalizedParentPath(anchor.parentUrl);
  if (parentUrl) return parentUrl;
  if (typeof anchor.frameHash === "string" && anchor.frameHash) {
    return parentUrlWithHash(anchor.frameHash);
  }
  return "";
}
function currentFrameLocation() {
  try {
    const loc = frame.contentWindow?.location;
    if (!loc) return {};
    return {
      framePathname: loc.pathname,
      frameSearch: loc.search,
      frameHash: loc.hash,
      frameUrl: loc.pathname + loc.search + loc.hash,
      parentUrl: window.location.pathname + window.location.search + window.location.hash
    };
  } catch (_error) {
    return {};
  }
}
function anchorWithLocation(anchor) {
  return { ...anchor, ...currentFrameLocation() };
}
function scrollToCommentTarget(thread, remainingRetries) {
  if (!reviewDoc || !thread) return false;
  ensureReviewBlocks();
  if (!reviewDoc.querySelector('.publicar-cx[data-comment="' + CSS.escape(thread.id) + '"]')) {
    renderHighlights();
  }
  const marker = reviewDoc.querySelector('.publicar-cx[data-comment="' + CSS.escape(thread.id) + '"]');
  const blockId = thread.anchor?.blockId;
  const block = blockId ? reviewDoc.querySelector('[data-review-block="' + CSS.escape(String(blockId)) + '"]') : null;
  const target = marker || block;
  if (target) {
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    return true;
  }
  if (remainingRetries > 0) window.setTimeout(() => scrollToCommentTarget(thread, remainingRetries - 1), 140);
  return false;
}
function restoreFrameLocation(thread, afterRestore) {
  const frameHash = typeof thread?.anchor?.frameHash === "string" ? thread.anchor.frameHash : "";
  const frameWindow = frame.contentWindow;
  if (!frameHash || !frameWindow || frameWindow.location.hash === frameHash) {
    if (frameHash) lastObservedFrameHash = frameHash;
    afterRestore();
    return;
  }
  syncingFrameHash = true;
  preferParentRoute();
  frameWindow.location.hash = frameHash;
  lastObservedFrameHash = frameHash;
  window.setTimeout(() => {
    syncingFrameHash = false;
    afterRestore();
  }, 140);
}
function scheduleRouteHighlightRender() {
  if (suppressHighlightObserver) return;
  if (routeHighlightTimer !== null) window.clearTimeout(routeHighlightTimer);
  routeHighlightTimer = window.setTimeout(() => {
    routeHighlightTimer = null;
    renderCurrentRouteHighlights(false);
  }, 0);
}
function installHighlightObserver() {
  if (!reviewDoc?.body || typeof MutationObserver === "undefined") return;
  highlightObserver?.disconnect();
  highlightObserver = new MutationObserver(() => scheduleRouteHighlightRender());
  highlightObserver.observe(reviewDoc.body, { childList: true, subtree: true, characterData: true });
}
function activateComment(id, scrollCard, scrollTarget = false) {
  const thread = comments.find((item) => item.id === id);
  if (!thread) return;
  rememberActiveComment(thread);
  const targetParentUrl = parentUrlForThread(thread);
  if (targetParentUrl) withRouteSync(() => {
    history.replaceState(null, "", targetParentUrl);
    lastObservedParentHash = parentRouteHash();
  });
  openCommentsRail();
  setActiveCommentSelection(thread, scrollCard);
  if (scrollTarget) restoreFrameLocation(thread, () => {
    scrollToCommentTarget(thread, 10);
  });
}
function renderComments() {
  countLabel.textContent = String(comments.length);
  commentsRoot.innerHTML = "";
  if (!comments.length) {
    commentsRoot.innerHTML = '<div class="empty">コメントはありません</div>';
    return;
  }
  comments.forEach((thread) => {
    const card = document.createElement("article");
    card.className = "review-card";
    card.dataset.commentCard = thread.id;
    card.dataset.status = thread.status;
    if (activeCommentId === thread.id) card.classList.add("active");
    const replies = thread.replies || [];
    const statusLabel = thread.status === "resolved" ? "解決済み" : "未解決";
    const statusIcon = thread.status === "resolved" ? "✓ " : "";
    card.innerHTML = '<div class="review-card-head"><span class="review-card-avatar">' + escapeText(authorInitial(thread.author)) + '</span><span class="review-card-author"><strong>' + escapeText(authorName(thread.author)) + actorKindBadge(thread.actorKind) + '</strong><span class="review-card-time">' + escapeText(formatTime(thread.createdAt)) + '</span></span></div>' +
      '<blockquote class="review-quote">' + escapeText(thread.selectedText || thread.anchor?.selectedText || "位置未確定") + '</blockquote>' +
      '<div class="review-body">' + escapeText(thread.body) + '</div>' +
      '<div class="review-meta"><span class="review-status ' + (thread.status === "resolved" ? "resolved" : "") + '">' + statusIcon + escapeText(statusLabel) + '</span>' + (replies.length ? '<span>' + replies.length + ' 件の返信</span>' : '<span></span>') + '</div>' +
      '<div class="review-replies">' + replies.map((reply) => '<div class="review-reply"><span class="review-reply-avatar">' + escapeText(authorInitial(reply.author)) + '</span><span class="review-reply-body"><strong>' + escapeText(authorName(reply.author)) + actorKindBadge(reply.actorKind) + ' <span class="review-card-time">' + escapeText(formatTime(reply.createdAt)) + '</span></strong><span>' + escapeText(reply.body) + '</span></span></div>').join("") + '</div>' +
      '<div class="review-actions"><textarea data-reply placeholder="返信"></textarea><div class="review-action-row"><span class="comment-shortcut">⌘+Enter</span><span class="comment-popover-actions"><button class="button secondary resolve-link" type="button" data-toggle-status>' + (thread.status === "resolved" ? "再オープン" : "解決") + '</button><button class="button secondary danger-link" type="button" data-delete-comment>削除</button><button class="button" type="button" data-send-reply>返信</button></span></div></div>';
    card.addEventListener("click", (event) => {
      if (!event.target.closest("button, textarea")) activateComment(thread.id, false, true);
    });
    card.querySelector("[data-send-reply]").addEventListener("click", () => sendReply(thread, card.querySelector("[data-reply]")));
    card.querySelector("[data-reply]").addEventListener("keydown", (event) => {
      if (!isSubmitShortcut(event)) return;
      event.preventDefault();
      sendReply(thread, event.currentTarget);
    });
    card.querySelector("[data-toggle-status]").addEventListener("click", () => updateThread(thread, { status: thread.status === "resolved" ? "open" : "resolved" }));
    card.querySelector("[data-delete-comment]").addEventListener("click", () => deleteThread(thread));
    commentsRoot.appendChild(card);
  });
}
function updateComposerButton() {
  if (!saveCommentButton) return;
  saveCommentButton.disabled = !commentBody.value.trim();
}
function isSubmitShortcut(event) {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}
async function loadComments() {
  const status = qs("#comment-status-filter").value || "open";
  const response = await fetch(apiBase() + "/comments?path=" + encodeURIComponent(reviewPath) + "&status=" + encodeURIComponent(status));
  if (!response.ok) return;
  const data = await response.json();
  comments = data.threads || [];
  renderComments();
  renderCurrentRouteHighlights(false);
  if (location.hash.startsWith("#comment-")) {
    activateComment(decodeURIComponent(location.hash.slice("#comment-".length)), true, true);
  }
}
async function saveComment() {
  if (!selected || !commentBody.value.trim()) return;
  const savedAnchor = anchorWithLocation(selected);
  const previousDisabled = saveCommentButton?.disabled;
  if (saveCommentButton) saveCommentButton.disabled = true;
  setStatus(commentStatus, "保存中...");
  const response = await fetch(apiBase() + "/comments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: reviewPath,
      body: commentBody.value.trim(),
      anchor: savedAnchor,
      selected_text: selected.selectedText,
      prefix: selected.prefix,
      suffix: selected.suffix,
      client_mutation_id: "ui-" + Date.now().toString(36)
    })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (saveCommentButton) saveCommentButton.disabled = Boolean(previousDisabled);
    setStatus(commentStatus, errorText(data, "保存に失敗しました"), "error");
    return;
  }
  popover.classList.remove("open");
  toolbar.classList.remove("open");
  commentBody.value = "";
  setStatus(commentStatus, "");
  updateComposerButton();
  if (workbench && !commentModeEnabled()) {
    setCommentMode(true);
  }
  openCommentsRail();
  await loadComments();
  if (!savedAnchor.frameHash || currentFrameHash() === savedAnchor.frameHash) {
    activateComment(data.thread.id, true, true);
  }
}
async function sendReply(thread, textarea) {
  const body = textarea.value.trim();
  if (!body) return;
  const response = await fetch(apiBase() + "/comments/" + encodeURIComponent(thread.id) + "/replies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body })
  });
  if (response.ok) {
    textarea.value = "";
    openCommentsRail();
    await loadComments();
    activateComment(thread.id, false, false);
  }
}
async function updateThread(thread, body) {
  const response = await fetch(apiBase() + "/comments/" + encodeURIComponent(thread.id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (response.ok) await loadComments();
}
async function deleteThread(thread) {
  if (!confirm("このコメントを削除しますか?")) return;
  const response = await fetch(apiBase() + "/comments/" + encodeURIComponent(thread.id), { method: "DELETE" });
  if (response.ok) await loadComments();
}
function parentUrlWithHash(hash) {
  return window.location.pathname + window.location.search + (hash || "");
}
function isFrameRouteHash(hash) {
  return typeof hash === "string" && Boolean(hash) && !hash.startsWith("#comment-");
}
function parentRouteHash() {
  return isFrameRouteHash(window.location.hash) ? window.location.hash : "";
}
function activeCommentMatchesRouteHash(hash) {
  if (!activeCommentId || !isFrameRouteHash(hash)) return false;
  const thread = comments.find((item) => item.id === activeCommentId);
  return Boolean(thread && threadFrameHash(thread) === hash);
}
function preferParentRoute() {
  parentRoutePriorityUntil = Date.now() + 1200;
  frameRoutePriorityUntil = 0;
}
function preferFrameRoute() {
  parentRoutePriorityUntil = 0;
  frameRoutePriorityUntil = Date.now() + 1200;
}
function withRouteSync(callback) {
  syncingFrameHash = true;
  try {
    callback();
  } finally {
    window.setTimeout(() => {
      syncingFrameHash = false;
    }, 0);
  }
}
function syncParentHashFromFrame() {
  if (!workbench) return;
  if (syncingFrameHash) {
    window.setTimeout(syncParentHashFromFrame, 50);
    return;
  }
  const parentHash = parentRouteHash();
  const hash = frame.contentWindow?.location.hash || "";
  const frameHashChanged = isFrameRouteHash(hash) && hash !== lastObservedFrameHash;
  if (isFrameRouteHash(hash)) lastObservedFrameHash = hash;
  if (isFrameRouteHash(parentHash) && parentHash !== hash && !(frameHashChanged && Date.now() < frameRoutePriorityUntil)) {
    preferParentRoute();
    lastObservedParentHash = parentHash;
    syncFrameHashFromParent();
    return;
  }
  if (parentHash && Date.now() < parentRoutePriorityUntil && Date.now() >= frameRoutePriorityUntil) return;
  if (!isFrameRouteHash(hash) || hash === window.location.hash) return;
  clearSelectionDraft();
  withRouteSync(() => {
    history.replaceState(null, "", parentUrlWithHash(hash));
    lastObservedParentHash = hash;
  });
  renderCurrentRouteHighlights(false);
}
function scheduleParentHashSync() {
  window.setTimeout(syncParentHashFromFrame, 0);
  window.setTimeout(syncParentHashFromFrame, 50);
}
function syncFrameHashFromParent() {
  const hash = parentRouteHash();
  if (!workbench || !hash) return;
  lastObservedParentHash = hash;
  if (syncingFrameHash) {
    window.setTimeout(syncFrameHashFromParent, 50);
    return;
  }
  const frameWindow = frame.contentWindow;
  if (!frameWindow) return;
  const frameHash = frameWindow.location.hash || "";
  if (frameHash === hash) {
    clearSelectionDraft();
    renderCurrentRouteHighlights(true);
    return;
  }
  if (isFrameRouteHash(frameHash) && Date.now() < frameRoutePriorityUntil) {
    scheduleParentHashSync();
    return;
  }
  preferParentRoute();
  clearSelectionDraft();
  renderCurrentRouteHighlights(true);
  withRouteSync(() => {
    frameWindow.location.hash = hash;
  });
}
function scheduleFrameHashSyncFromParent() {
  FRAME_HASH_SYNC_DELAYS_MS.forEach((delay) => window.setTimeout(syncFrameHashFromParent, delay));
}
function reconcileRouteState() {
  if (parentRouteHash()) {
    preferParentRoute();
    syncFrameHashFromParent();
    scheduleFrameHashSyncFromParent();
  } else {
    scheduleParentHashSync();
  }
}
function handleVisibilityRouteResume() {
  if (!document.hidden) reconcileRouteState();
}
function patchParentHistorySync() {
  if (window.__publicarParentHistorySyncPatched) return;
  try {
    ["pushState", "replaceState"].forEach((method) => {
      const original = history[method];
      if (typeof original !== "function") return;
      history[method] = function(...args) {
        const result = original.apply(this, args);
        if (!syncingFrameHash) {
          preferParentRoute();
          lastObservedParentHash = parentRouteHash();
          window.setTimeout(syncFrameHashFromParent, 0);
        }
        return result;
      };
    });
    window.__publicarParentHistorySyncPatched = true;
  } catch (_error) {
    // Hashchange, popstate, pageshow, visibilitychange, and polling still keep the route in sync.
  }
}
function patchFrameHistorySync() {
  const frameWindow = frame.contentWindow;
  if (!frameWindow || frameWindow.__publicarFrameHistorySyncPatched) return;
  try {
    ["pushState", "replaceState"].forEach((method) => {
      const original = frameWindow.history[method];
      if (typeof original !== "function") return;
      frameWindow.history[method] = function(...args) {
        const result = original.apply(this, args);
        preferFrameRoute();
        scheduleParentHashSync();
        return result;
      };
    });
    frameWindow.__publicarFrameHistorySyncPatched = true;
  } catch (_error) {
    // Same-origin review frames are patchable; if a browser blocks this, polling still keeps the route in sync.
  }
}
function installFrameHashSync() {
  if (!workbench || !frame.contentWindow) return;
  lastObservedFrameHash = currentFrameHash();
  lastObservedParentHash = parentRouteHash();
  patchParentHistorySync();
  patchFrameHistorySync();
  reconcileRouteState();
  const handleFrameRouteChange = () => {
    preferFrameRoute();
    syncParentHashFromFrame();
  };
  frame.contentWindow.addEventListener("hashchange", handleFrameRouteChange);
  frame.contentWindow.addEventListener("popstate", handleFrameRouteChange);
  reviewDoc?.addEventListener("click", () => {
    preferFrameRoute();
    scheduleParentHashSync();
  }, true);
  reviewDoc?.addEventListener("keyup", () => {
    preferFrameRoute();
    scheduleParentHashSync();
  }, true);
  const handleParentRouteChange = () => {
    preferParentRoute();
    lastObservedParentHash = parentRouteHash();
    clearSelectionDraft();
    scheduleFrameHashSyncFromParent();
  };
  window.addEventListener("hashchange", handleParentRouteChange);
  window.addEventListener("popstate", handleParentRouteChange);
  window.addEventListener("pageshow", reconcileRouteState);
  document.addEventListener("visibilitychange", handleVisibilityRouteResume);
  if (frameHashPoll === null) frameHashPoll = window.setInterval(syncParentHashFromFrame, 500);
}
function initializeReviewFrame() {
  try {
    reviewDoc = frame.contentDocument;
    if (!reviewDoc) throw new Error("frame document is not accessible");
    installReviewStyles();
    ensureReviewBlocks();
    installHighlightObserver();
    installFrameHashSync();
    reviewDoc.addEventListener("selectionchange", () => setTimeout(captureSelection, 0));
    reviewDoc.addEventListener("mouseup", () => setTimeout(captureSelection, 0));
    loadComments();
  } catch (error) {
    commentsRoot.innerHTML = '<div class="empty">レビュー対象HTMLを読み込めません</div>';
  }
}
qs("#open-comment-composer").addEventListener("click", () => {
  if (!selected) return;
  clearCommentComposerTimer();
  const rect = toolbar.getBoundingClientRect();
  positionFloating(popover, rect, true);
  commentBody.focus();
});
qs("#cancel-comment").addEventListener("click", () => {
  clearCommentComposerTimer();
  popover.classList.remove("open");
  commentBody.value = "";
  setStatus(commentStatus, "");
  updateComposerButton();
});
qs("#save-comment").addEventListener("click", saveComment);
commentBody.addEventListener("input", updateComposerButton);
commentBody.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    clearCommentComposerTimer();
    popover.classList.remove("open");
    commentBody.value = "";
    setStatus(commentStatus, "");
    updateComposerButton();
    return;
  }
  if (!isSubmitShortcut(event)) return;
  event.preventDefault();
  saveComment();
});
qs("#comment-status-filter").addEventListener("change", loadComments);
modeButton?.addEventListener("click", handleCommentModeToggle);
qs("[data-close-review-rail]")?.addEventListener("click", closeCommentsRail);
window.addEventListener("resize", () => {
  clearCommentComposerTimer();
  toolbar.classList.remove("open");
  popover.classList.remove("open");
});
function reviewFrameInitialSrc() {
  const baseSrc = frame.dataset.reviewSrc || "";
  if (!baseSrc) return "";
  return baseSrc + (parentRouteHash() || "");
}
function startReviewFrame() {
  // 本文内で別ファイルへ移動した場合は親画面を更新し、ヘッダーの入れ子と
  // 表示ファイル・コメント対象の不一致を防ぐ。同一オリジンのレビュー画面だけを対象にする。
  if (workbench && window.frameElement?.id === "review-frame") {
    window.parent.location.replace(window.location.href);
    return;
  }
  const src = reviewFrameInitialSrc();
  if (!src) {
    commentsRoot.innerHTML = '<div class="empty">レビュー対象HTMLを読み込めません</div>';
    return;
  }
  frame.src = src;
}
frame.addEventListener("load", () => {
  if (frame.contentWindow?.location.href === "about:blank") return;
  setTimeout(initializeReviewFrame, 0);
});
startReviewFrame();
if (frame.contentWindow?.location.href !== "about:blank" && frame.contentDocument?.readyState === "complete") {
  setTimeout(initializeReviewFrame, 0);
}
`;
}

export async function projectReview(c: Context<AppBindings>): Promise<Response> {
  const user = c.get("user") ?? null;
  if (!user) {
    return c.redirect("/auth/login", 302);
  }
  const projectId = c.req.param("id");
  const project = projectId ? await getProjectById(c.env, projectId) : null;
  if (!project || !(await canViewProject(c.env, project, user))) {
    return c.notFound();
  }
  const path = normalizeFilePath(c.req.query("path") ?? project.entryPath);
  if (!path) {
    return c.notFound();
  }
  return c.html(page(`${project.title} review - publicar`, projectReviewPage(user, project, path)));
}
