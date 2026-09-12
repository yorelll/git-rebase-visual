(function () {
  const vscode = acquireVsCodeApi();
  const listEl = document.getElementById("list");
  const bannerEl = document.getElementById("banner");
  const contextEl = document.getElementById("context");
  const contextTextEl = document.getElementById("context-text");
  const inlineToastEl = document.getElementById("inline-toast");
  const changesEl = document.getElementById("changes");
  const menuEl = document.getElementById("menu");
  const tooltipEl = document.getElementById("tooltip");
  const directionEl = document.getElementById("direction");

  let state = { commits: [], rebaseInProgress: false, llmConfigured: false, canonicalOrder: [] };
  let drag = null;
  let dragHint = "";
  let filterText = "";
  let selectedHashes = new Set();
  let selectionAnchor = null;
  let keyboardPickupHash = null;
  const expandedLockedRuns = new Set();
  let changesMoreOpen = false;
  let inlineToastTimer = null;
  let menuRestoreFocus = null;
  let menuClosing = false;
  let menuScrollCloseCount = 0;
  let searchFocus = null;
  let deferredState = null;
  let tipTimer = null;
  let tipHideTimer = null;
  let tipHash = null;
  let tipAnchor = null;
  let tipOverTip = false;

  function announce(message) {
    const live = document.getElementById("live");
    if (live) live.textContent = message;
  }

  function short(hash) { return (hash || "").slice(0, 8); }
  function setDragHint(message) { dragHint = message; renderDirection(); }
  function clearDragHint() { dragHint = ""; renderDirection(); }
  function renderDirection() {
    directionEl.textContent = dragHint;
    directionEl.classList.toggle("hidden", !dragHint);
  }

  function captureSearchFocus() {
    const active = document.activeElement;
    if (active && active.classList?.contains("commit-search")) {
      searchFocus = { start: active.selectionStart, end: active.selectionEnd };
    } else searchFocus = null;
  }
  function restoreSearchFocus() {
    if (!searchFocus) return;
    const search = listEl.querySelector(".commit-search");
    if (!search) return;
    search.focus();
    search.setSelectionRange(searchFocus.start ?? search.value.length, searchFocus.end ?? search.value.length);
    searchFocus = null;
  }
  function render() {
    captureSearchFocus();
    renderBanner(); renderContext(); renderChanges(); renderList(); restoreSearchFocus();
  }
  function renderContext() {
    if (!state.branchName) { contextEl.classList.add("hidden"); return; }
    // Keep the stable branch text in a child: the toast is an absolute overlay,
    // not a sibling inserted before the list, so document flow never changes.
    contextTextEl.textContent = `${state.branchName} · ${state.upstreamRef} · ↑${state.aheadCount || 0} ↓${state.behindCount || 0} · ${state.rangeLabel || ""}`;
    contextEl.classList.remove("hidden");
  }
  function showInlineToast(message, duration) {
    if (inlineToastTimer) clearTimeout(inlineToastTimer);
    inlineToastEl.textContent = message || "";
    inlineToastEl.classList.remove("hidden");
    inlineToastTimer = setTimeout(() => inlineToastEl.classList.add("hidden"), duration || 2500);
  }

  function button(label, onClick, options = {}) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn" + (options.primary ? " primary" : "") + (options.danger ? " danger-btn" : "");
    b.textContent = label; b.disabled = !!options.disabled; b.title = options.title || "";
    if (!b.disabled) b.onclick = onClick;
    return b;
  }

  function renderBanner() {
    bannerEl.innerHTML = "";
    if (!state.rebaseInProgress) {
      if (state.error) { bannerEl.className = "banner error"; bannerEl.textContent = state.error; bannerEl.classList.remove("hidden"); }
      else bannerEl.classList.add("hidden");
      return;
    }
    const stopped = state.commits.find((c) => c.hash === state.stoppedAt);
    const isConflict = state.conflictCount > 0;
    const isEditStop = state.pausedReason === "edit" && stopped;
    bannerEl.className = "banner rebase" + (isConflict ? " conflict" : "");
    const title = isConflict
      ? `变基暂停：${state.conflictCount} 个文件存在冲突`
      : isEditStop ? `变基停靠 (edit)：${short(stopped.hash)} “${stopped.subject}”` : "变基进行中，等待继续";
    const guidance = isConflict ? `请在编辑器解决并暂存冲突文件：${(state.conflictFiles || []).join("、")}。`
      : isEditStop ? "可修改代码或提交新改动后继续。" : "确认工作区状态后继续或 Abort。";
    const titleEl = document.createElement("div"); titleEl.className = "banner-title"; titleEl.textContent = title;
    const guideEl = document.createElement("div"); guideEl.textContent = guidance;
    const progress = document.createElement("div"); progress.className = "banner-progress";
    progress.textContent = state.totalSteps === undefined ? "进度 unknown（外部 rebase 无法可靠映射）" : `步骤 ${Math.min((state.completedSteps || 0) + 1, state.totalSteps)} / ${state.totalSteps}`;
    bannerEl.append(titleEl, guideEl, progress);
    if (isEditStop) {
      const editActions = document.createElement("div"); editActions.className = "edit-actions";
      const counts = document.createElement("div"); counts.className = "edit-counts";
      counts.textContent = `在此 commit 上的改动：${state.stagedCount || 0} 个暂存 · ${state.unstagedCount || 0} 个工作区文件`;
      editActions.appendChild(counts);
      const amendLabel = `追加到 ${short(stopped.hash)} (amend)…`;
      editActions.append(
        button(amendLabel, () => vscode.postMessage({ type: "openCompose", mode: "commit", hash: stopped.hash, ai: false, thenEdit: true, editKind: "amend" }), { primary: true, disabled: !state.hasStaged, title: state.hasStaged ? "编辑 message 后 amend 当前 edit commit" : "请先在 SCM 中暂存改动。" }),
        button("新建 commit…", () => vscode.postMessage({ type: "openCompose", mode: "staged", ai: false, thenEdit: false, editKind: "new" }), { disabled: !state.hasStaged, title: state.hasStaged ? "创建新 commit；变基暂停时不调用 AI。" : "请先在 SCM 中暂存改动。" }),
        button("AI 仅生成 message（不提交）", () => vscode.postMessage({ type: "openCompose", mode: state.hasStaged ? "staged" : "working", ai: true, thenEdit: false, messageOnly: true }), { disabled: !state.llmConfigured, title: state.llmConfigured ? "仅生成草稿，不执行提交" : "请先配置 LLM。" })
      );
      bannerEl.appendChild(editActions);
    }
    const actions = document.createElement("div"); actions.className = "banner-actions";
    actions.appendChild(button("Continue", () => vscode.postMessage({ type: "continueRebase" }), { primary: true, disabled: isConflict, title: isConflict ? `还有 ${state.conflictCount} 个文件未解决；解决并暂存后才能 Continue。` : "" }));
    if (isConflict) actions.appendChild(button("Skip（丢弃 patch）", () => vscode.postMessage({ type: "skipRebase" }), { danger: true }));
    actions.appendChild(button("Abort", () => vscode.postMessage({ type: "abortRebase" }), { danger: true }));
    bannerEl.appendChild(actions);
    bannerEl.classList.remove("hidden");
  }

  function changeKind(kind) { return ({ modify: "Modify", add: "Add", delete: "Delete", rename: "Rename", untracked: "Untracked", unmerged: "Conflict" })[kind] || "Modify"; }
  function appendChangeFiles(parent, changes) {
    const staged = changes.filter((change) => change.staged);
    const unstaged = changes.filter((change) => change.unstaged);
    const appendGroup = (title, items, side) => {
      if (!items.length) return;
      const label = document.createElement("div"); label.className = "file-group-label"; label.textContent = `${title} (${items.length})`; parent.appendChild(label);
      items.forEach((change) => {
        const row = document.createElement("div"); row.className = "change-file";
        const open = button(change.path, () => vscode.postMessage({ type: "openWorktreeDiff", path: change.path }));
        open.classList.add("file-open"); open.title = `打开 ${side === "staged" ? "HEAD ↔ index" : "index ↔ working tree"} Diff: ${change.path}`;
        const stateLabel = document.createElement("span"); stateLabel.className = "file-state";
        const kind = side === "staged" ? change.indexKind : change.worktreeKind;
        stateLabel.textContent = changeKind(kind);
        row.append(open, stateLabel);
        if (side === "unstaged" && !change.conflicted) {
          const stage = button("暂存", () => vscode.postMessage({ type: "stageFile", path: change.path }));
          stage.classList.add("file-stage"); stage.title = "git add -A -- 此文件"; row.appendChild(stage);
        } else if (side === "staged") {
          const ready = document.createElement("span"); ready.className = "file-staged"; ready.textContent = "已暂存"; row.appendChild(ready);
        }
        parent.appendChild(row);
      });
    };
    appendGroup("Staged Changes", staged, "staged");
    appendGroup("Changes", unstaged, "unstaged");
  }
  function renderChanges() {
    changesEl.innerHTML = "";
    if (!state.hasStaged && !state.hasUnstaged) { changesEl.classList.add("hidden"); return; }
    changesEl.classList.remove("hidden");
    const label = document.createElement("div"); label.className = "changes-label";
    label.textContent = `未提交的改动：${[state.hasStaged ? `${state.stagedCount || 0} 个暂存文件` : "", state.hasUnstaged ? `${state.unstagedCount || 0} 个工作区文件` : ""].filter(Boolean).join(" · ")}`;
    changesEl.appendChild(label);
    const atEditStop = state.rebaseInProgress && state.pausedReason === "edit";
    if (!atEditStop && !state.llmConfigured) {
      const hint = document.createElement("div"); hint.className = "changes-hint"; hint.textContent = "配置 LLM 后可生成 AI commit message。";
      changesEl.append(hint, button("打开 LLM 设置", () => vscode.postMessage({ type: "openLlmSettings" })));
    }
    if (state.hasStaged && !state.rebaseInProgress && state.llmConfigured) {
      changesEl.appendChild(changeButton("生成 message 并提交暂存区", { mode: "staged", ai: true, primary: true }));
    }
    const more = document.createElement("details"); more.className = "changes-more"; more.open = changesMoreOpen || atEditStop;
    more.addEventListener("toggle", () => { changesMoreOpen = more.open; persistUi(); });
    const summary = document.createElement("summary"); summary.textContent = atEditStop ? "本次 edit stop 的文件" : "更多提交选项"; more.appendChild(summary);
    appendChangeFiles(more, state.changes || []);
    if (!atEditStop) {
      if (state.hasUnstaged && state.llmConfigured && !state.rebaseInProgress) {
        const all = changeButton("提交全部改动（git add -A）⚠", { mode: "working", ai: true }); all.classList.add("danger-choice"); more.appendChild(all);
      }
      if (state.llmConfigured) more.appendChild(button("仅生成 message（不提交）", () => vscode.postMessage({ type: "openCompose", mode: state.hasStaged ? "staged" : "working", ai: true, thenEdit: false, messageOnly: true })));
    } else {
      const draftMode = state.hasStaged ? "staged" : "working";
      more.appendChild(button("AI 仅生成 message（不提交）", () => vscode.postMessage({ type: "openCompose", mode: draftMode, ai: true, thenEdit: false, messageOnly: true }), { disabled: !state.llmConfigured, title: state.llmConfigured ? "仅生成草稿，不执行提交" : "请先配置 LLM。" }));
    }
    changesEl.appendChild(more);
  }
  function changeButton(text, ctx) {
    return button(text, () => vscode.postMessage({ type: "openCompose", mode: ctx.mode, ai: ctx.ai, thenEdit: false }), { primary: ctx.primary });
  }

  function queryMatch(c, raw) {
    const query = raw.trim().toLowerCase();
    if (!query) return true;
    const terms = query.split(/\s+/);
    return terms.every((term) => {
      const field = term.match(/^(author|hash|msg):(.+)$/i);
      if (!field) return [c.shortHash, c.hash, c.subject, c.author, c.authorEmail, c.date].join(" ").toLowerCase().includes(term);
      const name = field[1].toLowerCase(); let value = field[2].toLowerCase();
      // `hash:0x8e…` is a prefix spelling convenience, not a JavaScript number.
      if (name === "hash" && /^0x[0-9a-f]+$/i.test(value)) value = value.slice(2);
      if (name === "hash") return c.hash.toLowerCase().startsWith(value) || c.shortHash.toLowerCase().startsWith(value);
      const target = name === "author" ? `${c.author} ${c.authorEmail}` : c.subject;
      return target.toLowerCase().includes(value);
    });
  }
  function filteredCommits() { return state.commits.filter((c) => queryMatch(c, filterText)); }
  function isFilterActive() { return filterText.trim().length > 0; }
  function commitIsPending(c) { return (state.pendingHashes || []).some((hash) => c.hash.startsWith(hash) || hash.startsWith(c.hash)); }
  function commitIsStopped(c) { return state.pausedReason === "edit" && state.stoppedAt === c.hash; }
  function isUnsafeToCollapse(c) {
    // Pending locked commits remain safe to summarize: the summary states that
    // they will replay, and all reordering remains disabled during a rebase.
    return (state.activeHash && (c.hash.startsWith(state.activeHash) || state.activeHash.startsWith(c.hash))) || commitIsStopped(c) || selectedHashes.has(c.hash);
  }
  function lockedRunKey(commits) { return commits.map((c) => c.hash).join(":"); }
  function runSummary(commits) {
    const authors = new Map();
    commits.forEach((c) => authors.set(c.author, (authors.get(c.author) || 0) + 1));
    const authorText = [...authors].map(([name, count]) => `${name} ×${count}`).join(" · ");
    const pending = commits.some(commitIsPending) ? " · 待重放" : "";
    return `🔒 ${commits.length} 个锁定 commit · 不会被推送 · ${authorText} · ${short(commits[0].hash)}…${short(commits.at(-1).hash)}${pending}`;
  }

  function renderList() {
    listEl.innerHTML = "";
    const known = new Set(state.commits.map((c) => c.hash));
    selectedHashes = new Set([...selectedHashes].filter((h) => known.has(h)));
    if (!state.commits.length) { const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "没有可显示的 commit。"; listEl.appendChild(empty); return; }
    const visible = filteredCommits();
    listEl.setAttribute("role", "listbox");
    listEl.setAttribute("aria-label", `Commit 时间轴，共 ${state.commits.length} 个 commit，显示 ${visible.length} 个，顶部较早，底部较新`);
    const controls = document.createElement("div"); controls.className = "list-controls";
    const search = document.createElement("input"); search.type = "search"; search.className = "commit-search"; search.placeholder = "搜索 hash、message、作者"; search.value = filterText;
    search.setAttribute("aria-label", "过滤 commit；过滤时禁用重排。支持 author:、hash:、msg:；hash:0x 前缀可省略。");
    // IMEs own the input's composing range. Rendering during composition would
    // replace the element and duplicate/corrupt Chinese input, so commit only
    // after compositionend. The input and its selection remain untouched until then.
    let composing = false;
    let compositionFinalValue = null;
    const applySearch = () => {
      filterText = search.value; keyboardPickupHash = null; persistUi(); renderList();
      const current = listEl.querySelector(".commit-search"); current?.focus();
      current?.setSelectionRange(search.selectionStart || 0, search.selectionEnd || 0);
    };
    search.addEventListener("compositionstart", () => { composing = true; compositionFinalValue = null; });
    search.addEventListener("compositionupdate", () => { /* Do not render while IME composes. */ });
    search.addEventListener("compositionend", () => { composing = false; compositionFinalValue = search.value; applySearch(); });
    search.addEventListener("input", (event) => {
      if (composing || event.isComposing) return;
      // Browsers commonly emit input again after compositionend. Its exact final
      // value was already applied above, so suppress that duplicate only.
      if (compositionFinalValue === search.value) { compositionFinalValue = null; return; }
      compositionFinalValue = null; applySearch();
    });
    controls.appendChild(search);
    const count = document.createElement("span"); count.className = "selection-count"; count.textContent = `${visible.length} / ${state.commits.length}`; controls.appendChild(count);
    if (filterText) controls.appendChild(button("清除", () => { filterText = ""; persistUi(); renderList(); listEl.querySelector(".commit-search")?.focus(); }));
    if (selectedHashes.size) {
      controls.append(
        button("批量锁定", () => vscode.postMessage({ type: "bulkLock", hashes: [...selectedHashes] })),
        button("批量 Squash", () => vscode.postMessage({ type: "bulkSquash", hashes: [...selectedHashes] })),
        button("批量删除", () => vscode.postMessage({ type: "bulkDrop", hashes: [...selectedHashes] }), { danger: true })
      );
    }
    listEl.appendChild(controls);
    const top = document.createElement("div"); top.className = "timeline-end"; top.textContent = "↑ Base / 较早"; listEl.appendChild(top);
    let pendingMarkerShown = false;
    let i = 0;
    while (i < visible.length) {
      const c = visible[i];
      if (commitIsPending(c) && !pendingMarkerShown) {
        const marker = document.createElement("div"); marker.className = "pending-boundary";
        const pendingCount = visible.slice(i).filter(commitIsPending).length;
        marker.textContent = `↓ 以下 ${pendingCount} 个 commit 待重放，Continue 后 hash 将变化`;
        listEl.appendChild(marker); pendingMarkerShown = true;
      }
      if (c.locked && !isUnsafeToCollapse(c)) {
        let end = i + 1;
        while (end < visible.length && visible[end].locked && !isUnsafeToCollapse(visible[end])) end++;
        if (state.collapseLockedRuns && end - i >= 3) { listEl.appendChild(lockedRunRow(visible.slice(i, end))); i = end; continue; }
      }
      listEl.appendChild(commitRow(c)); i++;
    }
    if (!visible.length) { const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "无匹配 · 清空搜索以显示全部 commit。"; listEl.appendChild(empty); }
    const bottom = document.createElement("div"); bottom.className = "timeline-end"; bottom.textContent = "↓ HEAD / 较新"; listEl.appendChild(bottom);
  }

  function lockedRunRow(commits) {
    const key = lockedRunKey(commits); const details = document.createElement("details"); details.className = "locked-run"; details.open = expandedLockedRuns.has(key);
    details.addEventListener("toggle", () => { if (details.open) expandedLockedRuns.add(key); else expandedLockedRuns.delete(key); persistUi(); });
    const summary = document.createElement("summary"); summary.textContent = runSummary(commits);
    summary.setAttribute("aria-label", `${runSummary(commits)}；拖入上半部插入 run 前，拖入下半部插入 run 后`);
    summary.addEventListener("dragover", (event) => { if (!drag || drag.filter || state.rebaseInProgress) return; event.preventDefault(); const after = isAfter(event, summary); clearDropMarkers(); details.classList.toggle("drop-before", !after); details.classList.toggle("drop-after", after); setDragHint(`将 ${short(drag.sourceHash)} 移动到锁定区 ${after ? "之后" : "之前"}`); });
    summary.addEventListener("dragleave", () => details.classList.remove("drop-before", "drop-after"));
    summary.addEventListener("drop", (event) => { if (!drag || drag.filter || state.rebaseInProgress) return; event.preventDefault(); const after = isAfter(event, summary); details.classList.remove("drop-before", "drop-after"); const source = drag.sourceHash; endDrag(false); reorder(source, after ? commits.at(-1).hash : commits[0].hash, after); });
    details.appendChild(summary); commits.forEach((c) => details.appendChild(commitRow(c))); return details;
  }

  function commitRow(c) {
    const row = document.createElement("div"); const pending = commitIsPending(c); const stopped = commitIsStopped(c); const selected = selectedHashes.has(c.hash); const index = state.commits.indexOf(c) + 1;
    row.className = `commit${c.locked ? " locked" : ""}${pending ? " pending" : ""}${stopped ? " stopped" : ""}${selected ? " selected" : ""}${keyboardPickupHash === c.hash ? " keyboard-pickup" : ""}`;
    row.dataset.hash = c.hash; row.tabIndex = 0; row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(selected));
    row.setAttribute("aria-label", `第 ${index} 项，共 ${state.commits.length} 项，${c.subject}，${short(c.hash)}，${c.author}${c.locked ? "，已锁定" : ""}${pending ? "，待重放" : ""}${stopped ? "，变基停靠于此" : ""}。选择后可按 Alt+上/下 移动一位。`);
    const grip = document.createElement("span"); grip.className = "grip"; grip.textContent = "⋮⋮"; grip.title = isFilterActive() ? "过滤中无法重排，请先清空搜索。" : c.locked ? "已锁定的 commit 不能拖动。" : "拖拽重排；顶部较早，底部较新"; grip.setAttribute("aria-hidden", "true"); grip.draggable = !state.rebaseInProgress && !isFilterActive() && !c.locked;
    const dot = document.createElement("span"); dot.className = "dot"; dot.textContent = c.authorInitial || "?"; dot.style.setProperty("--author-hue", c.authorColorKey || "0"); dot.title = `${c.author} <${c.authorEmail || "unknown"}>${c.isCurrentAuthor === false ? "（非当前作者）" : c.isCurrentAuthor === "unknown" ? "（当前作者未知）" : "（当前作者）"}`;
    const content = document.createElement("div"); content.className = "commit-content";
    const subject = document.createElement("span"); subject.className = "subject"; subject.textContent = c.subject;
    const meta = document.createElement("span"); meta.className = "commit-meta"; meta.textContent = `${short(c.hash)}${pending ? "*（待重放）" : ""} · ${c.author} · ${c.date}`; content.append(subject, meta);
    row.append(grip, dot, content);
    if (c.locked) { const lock = document.createElement("span"); lock.className = "lock-icon"; lock.textContent = "🔒"; lock.title = "已锁定：不可拖动、删除或追加。"; row.appendChild(lock); }
    if (stopped) { const badge = document.createElement("span"); badge.className = "stopped-badge"; badge.textContent = "⏸ 停在此"; row.appendChild(badge); }

    function canStartDrag() { return !state.rebaseInProgress && !isFilterActive() && !c.locked; }
    function startDrag(pointerId) {
      if (!canStartDrag()) return false;
      drag = { sourceHash: c.hash, revision: state.canonicalRevision, canonicalOrder: [...state.canonicalOrder], filter: isFilterActive(), pointerId };
      row.classList.add("dragging"); hideTooltip(); setDragHint(`正在移动 ${short(c.hash)}；顶部为较早，底部为较新`); return true;
    }
    function pointerTarget(event) {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".commit");
      if (!target || !drag) return undefined;
      const hash = target.dataset.hash; if (!hash || hash === drag.sourceHash) return undefined;
      return { row: target, hash, after: event.clientY > target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2 };
    }
    grip.addEventListener("pointerdown", (event) => {
      if (!startDrag(event.pointerId)) return;
      event.preventDefault(); grip.setPointerCapture?.(event.pointerId); announce(`已开始移动 ${short(c.hash)}；移动到目标上方或下方后松开。`);
    });
    grip.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const target = pointerTarget(event); clearDropMarkers();
      if (target) { target.row.classList.add(target.after ? "drop-after" : "drop-before"); setDragHint(`将 ${short(drag.sourceHash)} 移动到 ${short(target.hash)} ${target.after ? "之后" : "之前"}`); }
    });
    grip.addEventListener("pointerup", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const target = pointerTarget(event); const source = drag.sourceHash; endDrag(false);
      if (target) { announce(`将 ${short(source)} 移动到 ${short(target.hash)} ${target.after ? "之后" : "之前"}；等待确认。`); reorder(source, target.hash, target.after); }
      else clearDragHint();
    });
    grip.addEventListener("pointercancel", (event) => { if (drag?.pointerId === event.pointerId) endDrag(); });
    grip.addEventListener("dragstart", (event) => {
      if (!canStartDrag()) { event.preventDefault(); return; }
      startDrag(undefined); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", c.hash); event.dataTransfer.setData("application/x-git-rebase-visual", JSON.stringify({ sourceHash: c.hash, revision: state.canonicalRevision }));
    });
    grip.addEventListener("dragend", () => { row.classList.remove("dragging"); endDrag(); });
    row.addEventListener("dragover", (event) => { if (!drag || isFilterActive() || state.rebaseInProgress) return; event.preventDefault(); clearDropMarkers(); const after = isAfter(event, row); row.classList.add(after ? "drop-after" : "drop-before"); setDragHint(`将 ${short(drag.sourceHash)} 移动到 ${short(c.hash)} ${after ? "之后" : "之前"}`); });
    row.addEventListener("drop", (event) => { if (!drag || isFilterActive() || state.rebaseInProgress || drag.sourceHash === c.hash) return; event.preventDefault(); const after = isAfter(event, row); const source = drag.sourceHash; endDrag(false); reorder(source, c.hash, after); });
    row.addEventListener("contextmenu", (event) => { event.preventDefault(); openMenu(event.clientX, event.clientY, c, row); });
    row.addEventListener("click", (event) => selectRow(event, c));
    row.addEventListener("keydown", (event) => rowKeydown(event, c));
    row.addEventListener("mouseenter", () => scheduleTooltip(c, row)); row.addEventListener("mouseleave", cancelTooltip);
    return row;
  }
  function selectRow(event, c) {
    if (event.target.closest(".grip")) return;
    if (event.shiftKey && selectionAnchor) {
      const from = state.commits.findIndex((x) => x.hash === selectionAnchor); const to = state.commits.findIndex((x) => x.hash === c.hash);
      if (from >= 0 && to >= 0) for (const x of state.commits.slice(Math.min(from, to), Math.max(from, to) + 1)) selectedHashes.add(x.hash);
    } else if (event.ctrlKey || event.metaKey) { selectedHashes.has(c.hash) ? selectedHashes.delete(c.hash) : selectedHashes.add(c.hash); selectionAnchor = c.hash; }
    else { selectedHashes = new Set([c.hash]); selectionAnchor = c.hash; }
    renderList();
  }
  function rowKeydown(event, c) {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); const r = event.currentTarget.getBoundingClientRect(); openMenu(r.left + 8, r.bottom, c, event.currentTarget); return; }
    if ((event.ctrlKey || event.metaKey) && event.key === " ") { event.preventDefault(); selectRow({ ctrlKey: true, target: event.currentTarget }, c); return; }
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      if (state.rebaseInProgress || isFilterActive() || c.locked) {
        announce(state.rebaseInProgress ? "变基进行中，不能重排。" : isFilterActive() ? "过滤中无法重排，请先清空搜索。" : "已锁定的 commit 不能移动。"); return;
      }
      // A click/keyboard focus selects the source; then construct a complete,
      // one-step canonical intent. The host still asks for confirmation.
      selectedHashes = new Set([c.hash]); selectionAnchor = c.hash;
      const order = [...state.canonicalOrder]; const sourceAt = order.indexOf(c.hash); const direction = event.key === "ArrowUp" ? -1 : 1; const anchor = order[sourceAt + direction];
      if (!anchor) { announce(`已在${direction < 0 ? "最早" : "最新"}位置，不能继续移动。`); renderList(); return; }
      const proposed = [...order]; proposed.splice(sourceAt, 1); const destination = proposed.indexOf(anchor); proposed.splice(destination + (direction > 0 ? 1 : 0), 0, c.hash);
      announce(`将 ${short(c.hash)} 移动一位；等待宿主确认。`);
      vscode.postMessage({ type: "reorder", sourceHash: c.hash, anchorHash: anchor, placement: direction < 0 ? "before" : "after", revision: state.canonicalRevision, order: proposed }); renderList(); return;
    }
    if (state.rebaseInProgress || isFilterActive() || c.locked) return;
    if (event.key === " ") { event.preventDefault(); keyboardPickupHash = keyboardPickupHash ? null : c.hash; announce(keyboardPickupHash ? `已拾取 ${short(c.hash)}；使用箭头选择位置，Enter 放下。` : "已取消移动。"); renderList(); return; }
    if (!keyboardPickupHash) return;
    if (event.key === "Escape") { event.preventDefault(); keyboardPickupHash = null; renderList(); return; }
    if (event.key === "Enter" && keyboardPickupHash !== c.hash) { event.preventDefault(); const source = keyboardPickupHash; keyboardPickupHash = null; reorder(source, c.hash, false); }
  }
  function isAfter(event, target) { const r = target.getBoundingClientRect(); return event.clientY > r.top + r.height / 2; }
  function clearDropMarkers() { document.querySelectorAll(".commit.drop-before,.commit.drop-after,.locked-run.drop-before,.locked-run.drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after")); }
  function endDrag(clear = true) { document.querySelectorAll(".commit.dragging").forEach((row) => row.classList.remove("dragging")); drag = null; clearDropMarkers(); if (clear) clearDragHint(); if (deferredState) { state = deferredState; deferredState = null; render(); } }
  function reorder(sourceHash, anchorHash, after) {
    if (!sourceHash || isFilterActive() || state.rebaseInProgress || !state.canonicalOrder?.length) return;
    const order = [...state.canonicalOrder]; const sourceAt = order.indexOf(sourceHash); const anchorAt = order.indexOf(anchorHash);
    if (sourceAt < 0 || anchorAt < 0 || sourceHash === anchorHash) return;
    order.splice(sourceAt, 1); let destination = order.indexOf(anchorHash); order.splice(destination + (after ? 1 : 0), 0, sourceHash);
    vscode.postMessage({ type: "reorder", sourceHash, anchorHash, placement: after ? "after" : "before", revision: state.canonicalRevision, order });
  }

  function menuItem(item) {
    const el = document.createElement("button"); el.type = "button"; el.className = "item" + (item.disabled ? " disabled" : "") + (item.danger ? " danger" : ""); el.setAttribute("role", "menuitem"); el.tabIndex = -1;
    el.innerHTML = `<span class="menu-icon" aria-hidden="true">${item.icon || ""}</span><span>${item.label}</span>${item.shortcut ? `<kbd>${item.shortcut}</kbd>` : ""}`;
    if (item.disabled) { el.title = item.disabledReason || ""; el.setAttribute("aria-description", item.disabledReason || ""); } else el.onclick = () => { closeMenu(); item.action(); };
    return el;
  }
  function sep() { const el = document.createElement("div"); el.className = "sep"; el.setAttribute("role", "separator"); return el; }
  function group(text) { const el = document.createElement("div"); el.className = "menu-group-label"; el.textContent = text; return el; }
  function menuButtons() { return [...menuEl.querySelectorAll("button:not(.disabled)")]; }
  function focusMenu(index) { const buttons = menuButtons(); if (!buttons.length) return; const next = (index + buttons.length) % buttons.length; buttons.forEach((b, i) => b.tabIndex = i === next ? 0 : -1); buttons[next].focus(); }
  function openMenu(x, y, c, origin) {
    hideTooltip(); menuRestoreFocus = origin || document.activeElement; menuEl.innerHTML = "";
    const header = document.createElement("div"); header.className = "menu-header"; header.textContent = `${short(c.hash)} · ${c.subject}`; menuEl.append(header, sep(), group("查看"));
    menuEl.append(menuItem({ icon: "⧉", label: "复制 hash", action: () => send("copyHash", c) }), menuItem({ icon: "⧉", label: "复制 message", action: () => send("copyMessage", c) }), menuItem({ icon: "◫", label: "打开变更…", action: () => send("openDiff", c) }), sep(), group("编辑与变基"));
    menuEl.append(menuItem({ icon: "✎", label: "编辑 message…", shortcut: "Enter", action: () => sendCompose(c, false) }), menuItem({ icon: "✦", label: "AI 生成 message…", disabled: !state.llmConfigured, disabledReason: "请先配置 LLM。", action: () => sendCompose(c, true) }), menuItem({ icon: "⧉", label: "追加暂存区", disabled: c.locked || !state.hasStaged || state.rebaseInProgress, disabledReason: c.locked ? "目标已锁定。" : !state.hasStaged ? "暂存区为空。" : "变基进行中。", action: () => send("appendStaged", c) }));
    const position = state.commits.indexOf(c); const predecessor = state.commits[position - 1]; const blocked = position <= 0 || c.locked || predecessor?.locked || state.rebaseInProgress;
    const reason = position <= 0 ? "第一个 commit 不能合并到前驱。" : c.locked || predecessor?.locked ? "当前 commit 或前驱已锁定。" : state.rebaseInProgress ? "变基进行中。" : "";
    menuEl.append(menuItem({ icon: "⌑", label: "合并到上一个 (squash)", disabled: blocked, disabledReason: reason, action: () => send("squash", c) }), menuItem({ icon: "⌑", label: "合并到上一个，丢弃 message (fixup)", disabled: blocked, disabledReason: reason, action: () => send("fixup", c) }), menuItem({ icon: "⏸", label: "停靠在此 (edit)", action: () => send("rebaseTo", c) }), sep(), group("保护"), menuItem(c.locked ? { icon: "🔓", label: "解除锁定", action: () => send("unlock", c) } : { icon: "🔒", label: "锁定 commit", action: () => send("lock", c) }), sep(), group("危险操作"), menuItem({ icon: "⌫", label: "删除 commit (drop)", shortcut: "Delete", danger: true, disabled: c.locked, disabledReason: c.locked ? "目标已锁定。" : "", action: () => send("drop", c) }));
    menuEl.classList.remove("hidden"); const mw = menuEl.offsetWidth; const mh = menuEl.offsetHeight; menuEl.style.left = Math.max(4, Math.min(x, window.innerWidth - mw - 4)) + "px"; menuEl.style.top = Math.max(4, Math.min(y, window.innerHeight - mh - 4)) + "px"; menuEl.onkeydown = (event) => { const buttons = menuButtons(); const index = buttons.indexOf(document.activeElement); if (event.key === "ArrowDown") { event.preventDefault(); focusMenu(index + 1); } else if (event.key === "ArrowUp") { event.preventDefault(); focusMenu(index - 1); } else if (event.key === "Home") { event.preventDefault(); focusMenu(0); } else if (event.key === "End") { event.preventDefault(); focusMenu(buttons.length - 1); } else if (event.key === "Escape") { event.preventDefault(); closeMenu(); } }; focusMenu(0);
  }
  function sendCompose(c, ai) { vscode.postMessage({ type: "openCompose", mode: "commit", hash: c.hash, ai, thenEdit: false }); }
  function send(type, c) { vscode.postMessage({ type, hash: c.hash }); }
  function closeMenu() { if (menuEl.classList.contains("hidden")) return; menuClosing = true; menuEl.classList.add("hidden"); menuEl.innerHTML = ""; const restore = menuRestoreFocus; menuRestoreFocus = null; restore?.focus?.(); menuClosing = false; }
  document.addEventListener("click", (event) => { if (!menuEl.contains(event.target)) closeMenu(); }); document.addEventListener("contextmenu", (event) => { if (!event.target.closest(".commit")) closeMenu(); });
  // Scroll can only close the DOM menu. It deliberately neither calls
  // postMessage nor persistUi; __grvUiTrace exposes that invariant to tests.
  document.addEventListener("scroll", () => { menuScrollCloseCount++; closeMenu(); }, true); window.addEventListener("resize", closeMenu);

  function scheduleTooltip(c, row) { if (tipTimer) clearTimeout(tipTimer); if (tipHideTimer) clearTimeout(tipHideTimer); tipHash = c.hash; tipAnchor = row; tipTimer = setTimeout(() => vscode.postMessage({ type: "requestDetail", hash: c.hash }), 400); }
  function cancelTooltip() { if (tipTimer) clearTimeout(tipTimer); if (tipHideTimer) clearTimeout(tipHideTimer); tipHideTimer = setTimeout(() => { if (!tipOverTip) hideTooltip(); }, 200); }
  function hideTooltip() { tooltipEl.classList.add("hidden"); tipHash = null; tipAnchor = null; }
  function compactStat(stat) { const match = (stat || "").match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/); return match ? `${match[1]} file${match[1] === "1" ? "" : "s"}${match[2] ? ` · +${match[2]}` : ""}${match[3] ? ` −${match[3]}` : ""}` : stat; }
  function showDetail(d) {
    if (d.hash !== tipHash || !tipAnchor) return; tooltipEl.innerHTML = "";
    const top = document.createElement("div"); top.className = "tip-top"; const meta = document.createElement("div"); meta.className = "tip-meta"; meta.textContent = `${d.author} · ${d.relDate} · ${d.absDate}`;
    const actions = document.createElement("div"); actions.className = "tip-actions"; actions.append(button("⧉", () => vscode.postMessage({ type: "copyText", text: d.message }), { title: "复制完整 message" }), button("◫", () => vscode.postMessage({ type: "openDiff", hash: d.hash }), { title: "打开变更" })); top.append(meta, actions);
    const stat = document.createElement("div"); stat.className = "tip-stat"; stat.textContent = `${short(d.hash)} · ${compactStat(d.stat)}`;
    const msg = document.createElement("pre"); msg.className = "tip-msg"; msg.textContent = d.message; tooltipEl.append(top, stat, msg); tooltipEl.classList.remove("hidden");
    const r = tipAnchor.getBoundingClientRect(); const tw = tooltipEl.offsetWidth; const th = tooltipEl.offsetHeight; let topPos = r.bottom + 4; if (topPos + th > window.innerHeight - 4) topPos = Math.max(4, r.top - th - 4); tooltipEl.style.left = Math.max(4, Math.min(r.left, window.innerWidth - tw - 4)) + "px"; tooltipEl.style.top = topPos + "px";
  }
  tooltipEl.addEventListener("mouseenter", () => { tipOverTip = true; }); tooltipEl.addEventListener("mouseleave", () => { tipOverTip = false; hideTooltip(); });

  function persistUi() { vscode.setState({ filterText, changesMoreOpen, expandedLockedRuns: [...expandedLockedRuns] }); }
  function restoreUi() { const saved = vscode.getState(); if (!saved) return; filterText = typeof saved.filterText === "string" ? saved.filterText : ""; changesMoreOpen = !!saved.changesMoreOpen; (saved.expandedLockedRuns || []).forEach((key) => expandedLockedRuns.add(key)); }
  window.addEventListener("message", (event) => {
    const m = event.data;
    if (m.type === "state") {
      // A refresh must not destroy a native or pointer drag session. It is
      // applied after the shared session ends, preserving its revision guard.
      if (drag) { deferredState = m; return; }
      state = m; render();
    } else if (m.type === "detail") showDetail(m);
    else if (m.type === "inlineToast") showInlineToast(m.message, m.duration);
  });
  // Expose only a narrow trace hook for non-browser regression harnesses. It is
  // deliberately read-only and proves scroll closes menu without postMessage/state mutation.
  window.__grvUiTrace = () => ({ menuScrollCloseCount, menuClosing, dragging: !!drag, deferredRefresh: !!deferredState, filterText });
  restoreUi(); renderDirection(); vscode.postMessage({ type: "ready" });
})();
