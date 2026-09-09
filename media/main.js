(function () {
  const vscode = acquireVsCodeApi();

  const listEl = document.getElementById("list");
  const bannerEl = document.getElementById("banner");
  const contextEl = document.getElementById("context");
  const inlineToastEl = document.getElementById("inline-toast");
  const changesEl = document.getElementById("changes");
  const menuEl = document.getElementById("menu");
  const tooltipEl = document.getElementById("tooltip");

  const dialogEl = document.getElementById("dialog");
  const dialogTitle = document.getElementById("dialog-title");
  const dialogText = document.getElementById("dialog-text");
  const dialogOk = document.getElementById("dialog-ok");
  const dialogCancel = document.getElementById("dialog-cancel");
  const origBlock = document.getElementById("orig-block");
  const origText = document.getElementById("orig-text");
  const origCopy = document.getElementById("orig-copy");
  const aiBlock = document.getElementById("ai-block");
  const aiExtra = document.getElementById("ai-extra");
  const aiGenerate = document.getElementById("ai-generate");
  const trailerBlock = document.getElementById("trailer-block");
  const trailerText = document.getElementById("trailer-text");
  const directionEl = document.getElementById("direction");

  let state = { commits: [], rebaseInProgress: false, llmConfigured: false };
  let dragHash = null;
  let dialogCtx = null;
  let dialogApplying = false;
  let dialogError = "";
  let dragHint = "";
  let filterText = "";
  let selectedHashes = new Set();
  let keyboardPickupHash = null;
  let menuRestoreFocus = null;
  const expandedLockedRuns = new Set();
  let changesMoreOpen = false;
  let inlineToastTimer = null;
  let searchFocus = null;

  function announce(message) {
    const live = document.getElementById("live");
    if (live) {
      live.textContent = message;
    }
  }

  function setDialogError(message) {
    dialogError = message || "";
    const error = document.getElementById("dialog-error");
    if (error) {
      error.textContent = dialogError;
      error.classList.toggle("hidden", !dialogError);
    }
  }

  function setDialogApplying(applying) {
    dialogApplying = applying;
    dialogOk.disabled = applying;
    dialogCancel.disabled = applying;
    dialogText.readOnly = applying;
    dialogOk.textContent = applying ? "应用中…" : "应用";
  }

  function renderDirection() {
    // The top/bottom timeline anchors below already explain direction. Keep this
    // compact live region for keyboard drag feedback only, not duplicate chrome.
    if (!directionEl) return;
    directionEl.textContent = dragHint;
    directionEl.classList.toggle("hidden", !dragHint);
  }

  function clearDragHint() {
    dragHint = "";
    renderDirection();
  }

  function setDragHint(c, after) {
    dragHint = `将移动到 ${c.shortHash} “${c.subject}” ${after ? "之后（较新）" : "之前（较早）"}`;
    renderDirection();
  }

  function setMenuItemDisabled(el, disabled, reason) {
    el.className = "item" + (disabled ? " disabled" : "");
    if (reason) {
      el.title = reason;
      el.setAttribute("aria-description", reason);
    }
  }

  function menuSeparator() {
    const separator = document.createElement("div");
    separator.className = "sep";
    separator.setAttribute("role", "separator");
    return separator;
  }

  function menuGroupLabel(text) {
    const label = document.createElement("div");
    label.className = "menu-group-label";
    label.textContent = text;
    return label;
  }

  function menuItem(item) {
    const el = document.createElement("button");
    el.type = "button";
    el.setAttribute("role", "menuitem");
    el.tabIndex = -1;
    setMenuItemDisabled(el, !!item.disabled, item.disabledReason);
    if (item.danger) {
      el.classList.add("danger");
    }
    el.textContent = item.label;
    if (!item.disabled) {
      el.onclick = () => {
        closeMenu();
        item.action();
      };
    }
    return el;
  }

  function menuButtons() {
    return [...menuEl.querySelectorAll("button:not(.disabled)")];
  }

  function focusMenuButton(index) {
    const buttons = menuButtons();
    if (!buttons.length) return;
    const next = (index + buttons.length) % buttons.length;
    buttons.forEach((button, i) => { button.tabIndex = i === next ? 0 : -1; });
    buttons[next].focus();
  }

  function menuKeydown(event) {
    const buttons = menuButtons();
    const index = buttons.indexOf(document.activeElement);
    if (event.key === "ArrowDown") { event.preventDefault(); focusMenuButton(Math.max(0, index) + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); focusMenuButton((index < 0 ? 0 : index) - 1); }
    else if (event.key === "Home") { event.preventDefault(); focusMenuButton(0); }
    else if (event.key === "End") { event.preventDefault(); focusMenuButton(buttons.length - 1); }
    else if (event.key === "Escape") { event.preventDefault(); closeMenu(); }
  }

  function isDialogOpen() {
    return !dialogEl.classList.contains("hidden");
  }

  function escapeUi() {
    if (!menuEl.classList.contains("hidden")) {
      closeMenu();
      return true;
    }
    if (isDialogOpen() && !dialogApplying) {
      closeDialog();
      return true;
    }
    return false;
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && escapeUi()) {
      event.preventDefault();
      return;
    }
    if (
      isDialogOpen() &&
      !dialogApplying &&
      event.key === "Enter" &&
      (event.ctrlKey || event.metaKey)
    ) {
      event.preventDefault();
      dialogOk.click();
    }
  });

  renderDirection();

  // ---- rendering ----------------------------------------------------------

  function captureSearchFocus() {
    const active = document.activeElement;
    if (active && active.classList?.contains("commit-search")) {
      searchFocus = { start: active.selectionStart, end: active.selectionEnd };
    } else {
      searchFocus = null;
    }
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
    renderBanner();
    renderContext();
    renderChanges();
    renderList();
    restoreSearchFocus();
  }

  function renderContext() {
    if (!state.branchName) {
      contextEl.classList.add("hidden");
      return;
    }
    contextEl.textContent = `${state.branchName} · ${state.upstreamRef} · ↑${state.aheadCount || 0} ↓${state.behindCount || 0} · ${state.rangeLabel || ""}`;
    contextEl.classList.remove("hidden");
  }

  function showInlineToast(message, duration) {
    if (!inlineToastEl) return;
    if (inlineToastTimer) clearTimeout(inlineToastTimer);
    inlineToastEl.textContent = message || "";
    inlineToastEl.classList.remove("hidden");
    inlineToastTimer = setTimeout(() => inlineToastEl.classList.add("hidden"), duration || 2500);
  }

  function renderBanner() {
    if (state.rebaseInProgress) {
      bannerEl.className = "banner rebase" + (state.conflictCount ? " conflict" : "");
      const stopped = state.commits && state.commits.find((c) => c.hash === state.stoppedAt);
      const isConflict = state.conflictCount > 0;
      const isEditStop = state.pausedReason === "edit" && stopped;
      const title = isConflict
        ? `变基暂停：${state.conflictCount} 个文件存在冲突`
        : isEditStop
          ? `变基停靠 (edit)：${stopped.shortHash} “${stopped.subject}”`
          : "变基进行中，等待继续";
      const guidance = isConflict
        ? `请在编辑器解决并暂存冲突文件：${state.conflictFiles.join("、")}。`
        : isEditStop
          ? "可修改代码或提交新改动后继续。"
          : "确认工作区状态后继续或 Abort。";
      bannerEl.innerHTML = "";
      const titleEl = document.createElement("div");
      titleEl.className = "banner-title";
      titleEl.textContent = title;
      const guidanceEl = document.createElement("div");
      guidanceEl.textContent = guidance;
      const progress = state.totalSteps === undefined
        ? "进度 unknown（外部 rebase 无法可靠映射）"
        : `步骤 ${Math.min((state.completedSteps || 0) + 1, state.totalSteps)} / ${state.totalSteps}`;
      const progressEl = document.createElement("div");
      progressEl.className = "banner-progress";
      progressEl.textContent = progress;
      const actions = document.createElement("div");
      actions.className = "banner-actions";
      const continueButton = document.createElement("button");
      continueButton.className = "btn primary";
      continueButton.id = "b-continue";
      continueButton.textContent = "Continue";
      continueButton.disabled = isConflict;
      if (isConflict) {
        continueButton.title = `还有 ${state.conflictCount} 个文件未解决；解决并暂存后才能 Continue。`;
      }
      continueButton.onclick = () => vscode.postMessage({ type: "continueRebase" });
      if (isEditStop) {
        const editActions = document.createElement("div");
        editActions.className = "edit-actions";
        const counts = document.createElement("div");
        counts.className = "edit-counts";
        counts.textContent = `在此 commit 上的改动：${state.stagedCount || 0} 个暂存 · ${state.unstagedCount || 0} 个工作区文件`;
        const amend = document.createElement("button");
        amend.className = "btn primary";
        amend.textContent = "Amend 当前 commit…";
        amend.disabled = !state.hasStaged;
        amend.title = state.hasStaged ? "" : "请先在 SCM 中暂存改动。";
        amend.onclick = () => openEditStopCompose("amend");
        const create = document.createElement("button");
        create.className = "btn";
        create.textContent = "创建新 commit…";
        create.disabled = !state.hasStaged;
        create.title = state.hasStaged ? "" : "请先在 SCM 中暂存改动。";
        create.onclick = () => openEditStopCompose("new");
        const messageOnly = document.createElement("button");
        messageOnly.className = "btn";
        messageOnly.textContent = "仅生成 message";
        messageOnly.onclick = () => vscode.postMessage({ type: "openCompose", mode: "staged", ai: true, thenEdit: false });
        editActions.append(counts, amend, create, messageOnly);
      }
      if (isConflict) {
        const skip = document.createElement("button");
        skip.className = "btn danger-btn";
        skip.textContent = "Skip（丢弃 patch）";
        skip.onclick = () => vscode.postMessage({ type: "skipRebase" });
        actions.appendChild(skip);
      }
      const abortButton = document.createElement("button");
      abortButton.className = "btn danger-btn";
      abortButton.id = "b-abort";
      abortButton.textContent = "Abort";
      abortButton.onclick = () => vscode.postMessage({ type: "abortRebase" });
      actions.append(continueButton, abortButton);
      bannerEl.append(titleEl, guidanceEl, progressEl, actions);
      bannerEl.classList.remove("hidden");
      return;
    }
    if (state.error) {
      bannerEl.className = "banner error";
      bannerEl.textContent = state.error;
      bannerEl.classList.remove("hidden");
      return;
    }
    bannerEl.classList.add("hidden");
  }

  function renderChanges() {
    changesEl.innerHTML = "";
    const hasChanges = state.hasStaged || state.hasUnstaged;
    if (!hasChanges) {
      changesEl.classList.add("hidden");
      return;
    }
    changesEl.classList.remove("hidden");
    const label = document.createElement("div");
    label.className = "changes-label";
    const scope = [
      state.hasStaged ? `${state.stagedCount || 0} 个暂存文件` : "",
      state.hasUnstaged ? `${state.unstagedCount || 0} 个工作区文件` : "",
    ].filter(Boolean).join(" · ");
    label.textContent = `未提交的改动：${scope}`;
    changesEl.appendChild(label);
    if (!state.llmConfigured) {
      const hint = document.createElement("div");
      hint.className = "changes-hint";
      hint.textContent = "配置 LLM 后可生成 AI commit message。";
      changesEl.appendChild(hint);
      const settings = document.createElement("button");
      settings.className = "btn small";
      settings.textContent = "打开 LLM 设置";
      settings.onclick = () => vscode.postMessage({ type: "openLlmSettings" });
      changesEl.appendChild(settings);
      return;
    }
    if (state.hasStaged) {
      changesEl.appendChild(changeBtn("生成 message 并提交暂存区", { mode: "staged", ai: true, primary: true }));
    }
    const more = document.createElement("details");
    more.className = "changes-more";
    more.open = changesMoreOpen;
    more.addEventListener("toggle", () => { changesMoreOpen = more.open; });
    const summary = document.createElement("summary");
    summary.textContent = "更多提交选项";
    more.appendChild(summary);
    if (state.hasUnstaged) {
      const all = changeBtn("提交全部改动（git add -A）⚠", { mode: "working", ai: true });
      all.classList.add("danger-choice");
      more.appendChild(all);
    }
    const only = document.createElement("button");
    only.className = "btn small";
    only.textContent = "仅生成 message（不提交）";
    only.onclick = () => vscode.postMessage({ type: "openCompose", mode: state.hasStaged ? "staged" : "working", ai: true, thenEdit: false, messageOnly: true });
    more.appendChild(only);
    changesEl.appendChild(more);
  }

  function changeBtn(text, ctx) {
    const b = document.createElement("button");
    b.className = "btn small" + (ctx.primary ? " primary" : "");
    b.textContent = text;
    b.onclick = () =>
      vscode.postMessage({
        type: "openCompose",
        mode: ctx.mode,
        ai: ctx.ai,
        thenEdit: false,
      });
    return b;
  }

  function commitIsPending(c) {
    return (state.pendingHashes || []).some((hash) => c.hash.startsWith(hash) || hash.startsWith(c.hash));
  }

  function commitIsStopped(c) {
    return state.pausedReason === "edit" && state.stoppedAt && c.hash === state.stoppedAt;
  }

  function isUnsafeToCollapse(c) {
    const active = state.activeHash && (c.hash.startsWith(state.activeHash) || state.activeHash.startsWith(c.hash));
    return active || commitIsPending(c) || commitIsStopped(c) || selectedHashes.has(c.hash);
  }

  function filteredCommits() {
    const query = filterText.trim().toLowerCase();
    if (!query) return state.commits;
    return state.commits.filter((c) => [c.shortHash, c.hash, c.subject, c.author, c.date].join(" ").toLowerCase().includes(query));
  }

  function renderList() {
    listEl.innerHTML = "";
    const selectedKnown = new Set((state.commits || []).map((c) => c.hash));
    selectedHashes = new Set([...selectedHashes].filter((hash) => selectedKnown.has(hash)));
    if (!state.commits || state.commits.length === 0) {
      const d = document.createElement("div");
      d.className = "empty";
      d.textContent = "没有可显示的 commit。";
      listEl.appendChild(d);
      return;
    }
    const controls = document.createElement("div");
    controls.className = "list-controls";
    const search = document.createElement("input");
    search.type = "search"; search.className = "commit-search"; search.placeholder = "搜索 hash、message、作者";
    search.value = filterText; search.setAttribute("aria-label", "过滤 commit；过滤时禁用重排");
    search.oninput = () => {
      const cursor = search.selectionStart;
      filterText = search.value; keyboardPickupHash = null; renderList();
      const replacement = listEl.querySelector(".commit-search");
      replacement?.focus();
      if (cursor !== null) replacement?.setSelectionRange(cursor, cursor);
    };
    controls.appendChild(search);
    if (selectedHashes.size) {
      const selected = document.createElement("span"); selected.className = "selection-count"; selected.textContent = `已选 ${selectedHashes.size}`;
      const lock = document.createElement("button"); lock.className = "btn small"; lock.textContent = "批量锁定";
      lock.onclick = () => vscode.postMessage({ type: "bulkLock", hashes: [...selectedHashes] });
      const drop = document.createElement("button"); drop.className = "btn small danger-btn"; drop.textContent = "批量删除";
      drop.onclick = () => vscode.postMessage({ type: "bulkDrop", hashes: [...selectedHashes] });
      controls.append(selected, lock, drop);
    }
    listEl.appendChild(controls);
    const visible = filteredCommits();
    listEl.setAttribute("aria-label", `Commit 时间轴，共 ${state.commits.length} 个 commit，显示 ${visible.length} 个，顶部较早，底部较新`);
    const top = document.createElement("div");
    top.className = "timeline-end";
    top.textContent = "↑ Base / 较早";
    listEl.appendChild(top);
    let index = 0;
    while (index < visible.length) {
      const first = visible[index];
      const eligible = first.locked && !isUnsafeToCollapse(first);
      if (eligible) {
        let end = index + 1;
        while (end < visible.length && visible[end].locked && !isUnsafeToCollapse(visible[end])) end += 1;
        if (state.collapseLockedRuns && end - index >= 3) {
          listEl.appendChild(lockedRunRow(visible.slice(index, end)));
          index = end;
          continue;
        }
      }
      listEl.appendChild(commitRow(first));
      index += 1;
    }
    if (!visible.length) {
      const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "没有匹配的 commit。"; listEl.appendChild(empty);
    }
    const bottom = document.createElement("div");
    bottom.className = "timeline-end";
    bottom.textContent = "↓ HEAD / 较新";
    listEl.appendChild(bottom);
  }

  function lockedRunRow(commits) {
    const key = commits.map((commit) => commit.hash).join(":");
    const details = document.createElement("details");
    details.className = "locked-run";
    details.open = expandedLockedRuns.has(key);
    details.addEventListener("toggle", () => {
      if (details.open) expandedLockedRuns.add(key); else expandedLockedRuns.delete(key);
    });
    const summary = document.createElement("summary");
    summary.textContent = `🔒 ${commits.length} 个连续锁定 commit（可作为重排目标）`;
    summary.setAttribute("aria-label", `连续 ${commits.length} 个锁定 commit；将非锁定 commit 拖到摘要上半部插入之前，下半部插入之后`);
    summary.addEventListener("dragover", (event) => {
      if (filterText || state.rebaseInProgress || !dragHash) return;
      event.preventDefault();
      clearDropMarkers();
      const after = isAfter(event, summary);
      details.classList.toggle("drop-before", !after);
      details.classList.toggle("drop-after", after);
      dragHint = `将移动到 locked run ${after ? "之后（较新）" : "之前（较早）"}`;
      renderDirection();
    });
    summary.addEventListener("dragleave", () => details.classList.remove("drop-before", "drop-after"));
    summary.addEventListener("drop", (event) => {
      if (filterText || state.rebaseInProgress || !dragHash) return;
      event.preventDefault();
      const after = isAfter(event, summary);
      details.classList.remove("drop-before", "drop-after");
      clearDragHint();
      reorderAtRunBoundary(dragHash, commits, after);
    });
    details.appendChild(summary);
    for (const commit of commits) details.appendChild(commitRow(commit));
    return details;
  }

  function commitRow(c) {
    const row = document.createElement("div");
    const stopped = commitIsStopped(c);
    const index = state.commits.indexOf(c) + 1;
    const pending = commitIsPending(c);
    const selected = selectedHashes.has(c.hash);
    row.className =
      "commit" + (c.locked ? " locked" : "") + (stopped ? " stopped" : "") + (pending ? " pending" : "") + (selected ? " selected" : "") + (keyboardPickupHash === c.hash ? " keyboard-pickup" : "");
    // HTML drag is enabled only while pointer starts on the grip below.
    row.draggable = false;
    row.dataset.hash = c.hash;
    row.tabIndex = 0;
    row.setAttribute("role", "listitem");
    row.setAttribute("aria-selected", String(selected));
    row.setAttribute(
      "aria-label",
      `第 ${index} 个，共 ${state.commits.length} 个，${c.subject}，${pending ? "待重放，原 hash 将在 Continue 后变化，" : ""}${c.shortHash}，${c.author}，${c.date}${c.locked ? "，已锁定" : ""}${stopped ? "，变基停靠于此" : ""}${selected ? "，已选择" : ""}${keyboardPickupHash === c.hash ? "，已拾取，使用上下箭头选择位置，Enter 放下，Escape 取消" : ""}`
    );

    const grip = document.createElement("span");
    grip.className = "grip";
    grip.textContent = "⋮⋮";
    grip.title = "拖拽重排；顶部较早，底部较新";
    grip.setAttribute("aria-hidden", "true");
    grip.draggable = !state.rebaseInProgress;
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.textContent = c.authorInitial || "?";
    dot.style.setProperty("--author-hue", c.authorColorKey || "0");
    dot.title = `${c.author}${c.isCurrentAuthor === false ? "（非当前作者）" : c.isCurrentAuthor === "unknown" ? "（当前作者未知）" : "（当前作者）"}`;
    dot.setAttribute("aria-label", dot.title);

    const content = document.createElement("div");
    content.className = "commit-content";
    const subject = document.createElement("span");
    subject.className = "subject";
    subject.textContent = c.subject;
    const meta = document.createElement("span");
    meta.className = "commit-meta";
    meta.textContent = `${pending ? `${c.shortHash.slice(0, 8)}*（待重放）` : c.shortHash.slice(0, 8)} · ${c.author} · ${c.date}`;
    content.append(subject, meta);
    if (pending) {
      const pendingText = document.createElement("span");
      pendingText.className = "pending-text";
      pendingText.textContent = "待重放：Continue 后 hash 将变化";
      content.appendChild(pendingText);
    }
    row.append(grip, dot, content);

    if (c.locked) {
      const lock = document.createElement("span");
      lock.className = "lock-icon";
      lock.textContent = "🔒";
      lock.title = "已锁定：先解除锁定才能删除或追加。";
      row.appendChild(lock);
    }
    if (stopped) {
      const badge = document.createElement("span");
      badge.className = "stopped-badge";
      badge.textContent = "⏸ 停在此";
      row.appendChild(badge);
    }

    grip.addEventListener("dragstart", (e) => {
      if (state.rebaseInProgress || filterText) { e.preventDefault(); return; }
      dragHash = c.hash;
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      dragHint = `正在移动 ${c.shortHash}；顶部为较早，底部为较新`;
      renderDirection();
      hideTooltip();
    });
    grip.addEventListener("dragend", () => {
      dragHash = null;
      row.classList.remove("dragging");
      clearDropMarkers();
      clearDragHint();
    });
    row.addEventListener("dragover", (e) => {
      if (filterText || state.rebaseInProgress) return;
      e.preventDefault();
      clearDropMarkers();
      const after = isAfter(e, row);
      row.classList.add(after ? "drop-after" : "drop-before");
      setDragHint(c, after);
    });
    row.addEventListener("drop", (e) => {
      if (filterText || state.rebaseInProgress) return;
      e.preventDefault();
      const after = isAfter(e, row);
      clearDropMarkers();
      clearDragHint();
      if (dragHash && dragHash !== c.hash) {
        reorder(dragHash, c.hash, after);
      }
    });

    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, c, row);
    });
    row.addEventListener("click", (e) => {
      if (e.target.closest(".grip")) return;
      if (e.ctrlKey || e.metaKey) {
        if (selectedHashes.has(c.hash)) selectedHashes.delete(c.hash); else selectedHashes.add(c.hash);
        renderList();
      }
    });
    row.addEventListener("keydown", (e) => {
      if ((e.key === "ContextMenu") || (e.shiftKey && e.key === "F10")) {
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        openMenu(rect.left + 8, rect.bottom, c, row);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === " ") {
        e.preventDefault();
        if (selectedHashes.has(c.hash)) selectedHashes.delete(c.hash); else selectedHashes.add(c.hash);
        renderList();
        return;
      }
      if (state.rebaseInProgress || filterText) return;
      if (e.key === " ") {
        e.preventDefault();
        keyboardPickupHash = keyboardPickupHash ? null : c.hash;
        announce(keyboardPickupHash ? `已拾取 ${c.shortHash}；使用上下箭头选择位置，Enter 放下。` : "已取消移动。");
        renderList();
        return;
      }
      if (!keyboardPickupHash) return;
      if (e.key === "Escape") {
        e.preventDefault(); keyboardPickupHash = null; announce("已取消移动。"); renderList(); return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (keyboardPickupHash !== c.hash) reorder(keyboardPickupHash, c.hash, false);
        keyboardPickupHash = null;
        return;
      }
      if (["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const source = state.commits.find((commit) => commit.hash === keyboardPickupHash);
        const position = state.commits.indexOf(c);
        let target = position;
        if (e.key === "ArrowUp") target = Math.max(0, position - 1);
        if (e.key === "ArrowDown") target = Math.min(state.commits.length - 1, position + 1);
        if (e.key === "Home") target = 0;
        if (e.key === "End") target = state.commits.length - 1;
        const targetRow = document.querySelector(`.commit[data-hash="${state.commits[target].hash}"]`);
        targetRow?.focus();
        announce(`移动 ${source?.shortHash ?? "commit"} 到第 ${target + 1} 个位置；Enter 放下。`);
      }
    });

    // hover tooltip
    row.addEventListener("mouseenter", () => scheduleTooltip(c, row));
    row.addEventListener("mouseleave", () => cancelTooltip(c.hash));

    return row;
  }

  function clearDropMarkers() {
    document
      .querySelectorAll(".commit.drop-before, .commit.drop-after, .locked-run.drop-before, .locked-run.drop-after")
      .forEach((el) => el.classList.remove("drop-before", "drop-after"));
  }

  // True when the cursor is in the lower half of the row (insert AFTER it).
  function isAfter(e, row) {
    const r = row.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2;
  }

  // ---- reorder ------------------------------------------------------------

  function applyReorder(order) {
    const byHash = new Map(state.commits.map((c) => [c.hash, c]));
    state.commits = order.map((h) => byHash.get(h));
    renderList();
    vscode.postMessage({ type: "reorder", order });
  }

  function reorder(fromHash, targetHash, after) {
    // Filtering is a view projection only; a partial order must never be sent
    // to the host. Reorder always sends the complete canonical order.
    if (filterText || state.rebaseInProgress) {
      announce("过滤或变基期间不能重排。 ");
      return;
    }
    const order = state.commits.map((c) => c.hash);
    const fromIdx = order.indexOf(fromHash);
    if (fromIdx < 0) return;
    order.splice(fromIdx, 1);
    let targetIdx = order.indexOf(targetHash);
    if (targetIdx < 0) return;
    if (after) targetIdx += 1;
    order.splice(targetIdx, 0, fromHash);
    applyReorder(order);
  }

  function reorderAtRunBoundary(fromHash, commits, after) {
    if (filterText || state.rebaseInProgress || commits.some((commit) => commit.hash === fromHash)) return;
    const order = state.commits.map((commit) => commit.hash);
    const fromIdx = order.indexOf(fromHash);
    if (fromIdx < 0) return;
    order.splice(fromIdx, 1);
    const boundaryHash = after ? commits[commits.length - 1].hash : commits[0].hash;
    let targetIdx = order.indexOf(boundaryHash);
    if (targetIdx < 0) return;
    if (after) targetIdx += 1;
    order.splice(targetIdx, 0, fromHash);
    applyReorder(order);
  }

  // ---- context menu -------------------------------------------------------

  function openMenu(x, y, c, origin) {
    hideTooltip();
    menuRestoreFocus = origin || document.activeElement;
    menuEl.innerHTML = "";
    menuEl.setAttribute("role", "menu");
    const header = document.createElement("div");
    header.className = "menu-header";
    header.textContent = `${c.shortHash} · ${c.subject}`;
    header.title = c.subject;
    menuEl.append(header, menuSeparator());

    menuEl.append(menuGroupLabel("查看"));
    menuEl.append(menuItem({ label: "复制 commit hash", action: () => send("copyHash", c) }));
    menuEl.append(menuItem({ label: "复制 message", action: () => send("copyMessage", c) }));
    menuEl.append(menuItem({ label: "打开变更…", action: () => vscode.postMessage({ type: "openDiff", hash: c.hash }) }));
    menuEl.append(menuSeparator(), menuGroupLabel("编辑与变基"));
    menuEl.append(menuItem({
      label: "编辑 message…",
      action: () => vscode.postMessage({ type: "openCompose", mode: "commit", hash: c.hash, ai: false, thenEdit: false }),
    }));
    menuEl.append(menuItem({
      label: "AI 生成 message…",
      disabled: !state.llmConfigured,
      disabledReason: "请先配置 LLM。",
      action: () => vscode.postMessage({ type: "openCompose", mode: "commit", hash: c.hash, ai: true, thenEdit: false }),
    }));
    menuEl.append(menuItem({
      label: "编辑 message 并停靠在此…",
      action: () => vscode.postMessage({ type: "openCompose", mode: "commit", hash: c.hash, ai: false, thenEdit: true }),
    }));
    menuEl.append(menuItem({ label: "停靠在此 (edit)", action: () => send("rebaseTo", c) }));
    const position = state.commits.indexOf(c);
    const previous = state.commits[position - 1];
    const combineReason = position <= 0
      ? "第一个 commit 不能合并到前驱。"
      : c.locked || previous?.locked
        ? "当前 commit 或前驱已锁定。"
        : state.rebaseInProgress ? "变基进行中。" : "";
    menuEl.append(menuItem({ label: combineReason ? `合并到上一个 (squash)（${combineReason.replace(/。$/, "")}）` : "合并到上一个 (squash)", disabled: !!combineReason, disabledReason: combineReason, action: () => send("squash", c) }));
    menuEl.append(menuItem({ label: combineReason ? `合并到上一个，丢弃 message (fixup)（${combineReason.replace(/。$/, "")}）` : "合并到上一个，丢弃 message (fixup)", disabled: !!combineReason, disabledReason: combineReason, action: () => send("fixup", c) }));

    const appendReason = c.locked
      ? "目标已锁定，请先解除锁定。"
      : !state.hasStaged
        ? "暂存区为空。"
        : state.rebaseInProgress
          ? "变基进行中。"
          : "";
    menuEl.append(menuItem({
      label: appendReason
        ? `追加暂存区（${appendReason.replace(/。$/, "")}）`
        : `追加暂存区（${state.stagedCount || 0} 个文件）`,
      disabled: !!appendReason,
      disabledReason: appendReason,
      action: () => send("appendStaged", c),
    }));

    menuEl.append(menuSeparator(), menuGroupLabel("保护"));
    menuEl.append(menuItem(
      c.locked
        ? { label: "解除锁定", action: () => send("unlock", c) }
        : { label: "锁定 commit", action: () => send("lock", c) }
    ));
    menuEl.append(menuSeparator(), menuGroupLabel("危险操作"));
    menuEl.append(menuItem({
      label: c.locked ? "删除 commit（已锁定，需先解锁）" : "删除 commit (drop)",
      disabled: c.locked,
      disabledReason: c.locked ? "目标已锁定，请先解除锁定。" : "",
      danger: true,
      action: () => send("drop", c),
    }));

    menuEl.classList.remove("hidden");
    const mw = menuEl.offsetWidth;
    const mh = menuEl.offsetHeight;
    menuEl.style.left = Math.max(4, Math.min(x, window.innerWidth - mw - 4)) + "px";
    menuEl.style.top = Math.max(4, Math.min(y, window.innerHeight - mh - 4)) + "px";
    menuEl.onkeydown = menuKeydown;
    focusMenuButton(0);
  }

  function closeMenu() {
    menuEl.classList.add("hidden");
    menuEl.innerHTML = "";
    const restore = menuRestoreFocus;
    menuRestoreFocus = null;
    restore?.focus?.();
  }

  function send(type, c) {
    vscode.postMessage({ type, hash: c.hash });
  }

  document.addEventListener("click", (e) => {
    if (!menuEl.contains(e.target)) {
      closeMenu();
    }
  });
  document.addEventListener("contextmenu", (e) => {
    if (!e.target.closest(".commit")) {
      closeMenu();
    }
  });
  document.addEventListener("scroll", closeMenu, true);
  window.addEventListener("resize", closeMenu);

  // ---- hover tooltip ------------------------------------------------------

  let tipTimer = null;
  let tipHideTimer = null;
  let tipHash = null;
  let tipAnchor = null;
  let tipOverTip = false;

  function scheduleTooltip(c, row) {
    // Cancel any pending open/hide, then arm a fresh open. Do NOT null tipHash
    // here — the incoming detail response is matched against it.
    if (tipTimer) clearTimeout(tipTimer);
    if (tipHideTimer) clearTimeout(tipHideTimer);
    tipHash = c.hash;
    tipAnchor = row;
    tipTimer = setTimeout(() => {
      vscode.postMessage({ type: "requestDetail", hash: c.hash });
    }, 400);
  }

  function cancelTooltip() {
    if (tipTimer) {
      clearTimeout(tipTimer);
      tipTimer = null;
    }
    // Delay the hide so the mouse can travel into the tooltip (to copy).
    if (tipHideTimer) clearTimeout(tipHideTimer);
    tipHideTimer = setTimeout(() => {
      if (!tipOverTip) {
        hideTooltip();
      }
    }, 200);
  }

  function hideTooltip() {
    tooltipEl.classList.add("hidden");
    tipHash = null;
    tipAnchor = null;
  }

  function showDetail(d) {
    if (d.hash !== tipHash || !tipAnchor) {
      return;
    }
    tooltipEl.innerHTML = "";

    const meta = document.createElement("div");
    meta.className = "tip-meta";
    const author = document.createElement("span");
    author.className = "tip-author";
    author.textContent = d.author;
    const date = document.createElement("span");
    date.className = "tip-date";
    date.textContent = `${d.relDate} · ${d.absDate}`;
    meta.appendChild(author);
    meta.appendChild(date);

    const stat = document.createElement("div");
    stat.className = "tip-stat";
    stat.textContent = `${d.hash.slice(0, 10)}${d.stat ? "  ·  " + d.stat : ""}`;

    const msg = document.createElement("pre");
    msg.className = "tip-msg";
    msg.textContent = d.message;

    const copy = document.createElement("button");
    copy.className = "link-btn";
    copy.textContent = "复制完整 message";
    copy.onclick = () => vscode.postMessage({ type: "copyText", text: d.message });

    tooltipEl.appendChild(meta);
    tooltipEl.appendChild(stat);
    tooltipEl.appendChild(msg);
    tooltipEl.appendChild(copy);
    tooltipEl.classList.remove("hidden");

    const r = tipAnchor.getBoundingClientRect();
    const tw = tooltipEl.offsetWidth;
    const th = tooltipEl.offsetHeight;
    // Always anchor below the row; if it would overflow the viewport bottom,
    // clamp it downward (the tooltip scrolls internally) instead of flipping
    // above the row — flipping up would cover the commit list and block clicks.
    let top = r.bottom + 4;
    if (top + th > window.innerHeight - 4) {
      top = Math.max(4, window.innerHeight - th - 4);
    }
    tooltipEl.style.left = Math.max(4, Math.min(r.left, window.innerWidth - tw - 4)) + "px";
    tooltipEl.style.top = top + "px";
  }

  tooltipEl.addEventListener("mouseenter", () => (tipOverTip = true));
  tooltipEl.addEventListener("mouseleave", () => {
    tipOverTip = false;
    hideTooltip();
  });

  // ---- compose dialog -----------------------------------------------------

  function openEditStopCompose(kind) {
    dialogCtx = { mode: "editStop", editKind: kind, hash: state.stoppedAt, thenEdit: false, ai: false };
    dialogApplying = false;
    dialogText.readOnly = false;
    dialogText.value = "";
    dialogTitle.textContent = kind === "amend" ? "Amend 当前 edit commit" : "在 edit 停靠创建新 commit";
    origBlock.classList.add("hidden"); aiBlock.classList.add("hidden"); trailerBlock.classList.add("hidden");
    setDialogError("");
    dialogEl.classList.remove("hidden");
    dialogText.focus();
  }

  function openDialog(m) {
    dialogCtx = {
      mode: m.mode,
      hash: m.hash,
      thenEdit: m.thenEdit === true,
      ai: m.ai === true,
      messageOnly: m.messageOnly === true,
    };
    // Must reset before making the dialog visible: closeDialog intentionally
    // refuses to close while an apply is pending.
    dialogApplying = false;
    dialogOk.disabled = false;
    dialogCancel.disabled = false;
    dialogText.readOnly = false;
    dialogOk.textContent = "应用";
    setDialogError("");

    // Title
    if (m.mode === "staged") {
      dialogTitle.textContent = "为暂存区生成 commit message";
    } else if (m.mode === "working") {
      dialogTitle.textContent = "为工作区改动生成 commit message";
    } else if (m.ai) {
      dialogTitle.textContent = "AI 生成 commit message";
    } else if (m.thenEdit) {
      dialogTitle.textContent = "更改 message 并变基至此";
    } else {
      dialogTitle.textContent = "更改 commit message";
    }

    // Original (for comparison) — only when editing an existing commit.
    const hasOriginal = m.mode === "commit" && (m.original || "").length > 0;
    if (hasOriginal) {
      origText.value = m.original;
      origBlock.classList.remove("hidden");
    } else {
      origBlock.classList.add("hidden");
    }

    // AI controls
    if (m.ai) {
      aiExtra.value = "";
      aiBlock.classList.remove("hidden");
    } else {
      aiBlock.classList.add("hidden");
    }

    // Result box: prefill with original body for a commit edit; empty otherwise.
    dialogText.value = m.mode === "commit" ? m.original || "" : "";

    // Always start with a fresh, enabled generate button.
    resetGenerateBtn();

    // Preserved trailers
    if (m.trailers && m.trailers.length > 0) {
      trailerText.textContent = m.trailers;
      trailerBlock.classList.remove("hidden");
    } else {
      trailerBlock.classList.add("hidden");
    }

    dialogEl.classList.remove("hidden");
    dialogText.focus();
  }

  function closeDialog() {
    if (dialogApplying) {
      return;
    }
    dialogEl.classList.add("hidden");
    dialogCtx = null;
    setDialogError("");
  }

  origCopy.onclick = () =>
    vscode.postMessage({ type: "copyText", text: origText.value });

  aiGenerate.onclick = () => {
    if (!dialogCtx) {
      return;
    }
    aiGenerate.disabled = true;
    aiGenerate.textContent = "生成中…";
    dialogText.value = "";
    vscode.postMessage({
      type: "generate",
      mode: dialogCtx.mode,
      hash: dialogCtx.hash,
      extra: aiExtra.value,
    });
  };

  dialogCancel.onclick = closeDialog;

  dialogOk.onclick = () => {
    if (!dialogCtx || dialogApplying) {
      return;
    }
    const message = dialogText.value.trim();
    if (message.length === 0) {
      setDialogError("Commit message 不能为空。");
      dialogText.focus();
      return;
    }
    setDialogError("");
    setDialogApplying(true);
    if (dialogCtx.mode === "editStop") {
      vscode.postMessage({ type: dialogCtx.editKind === "amend" ? "commitEditAmend" : "commitEditNew", message });
    } else if (dialogCtx.messageOnly) {
      setDialogApplying(false);
      vscode.postMessage({ type: "copyText", text: message });
      announce("已生成 message，尚未提交。");
    } else {
      vscode.postMessage({
        type: "apply",
        mode: dialogCtx.mode,
        hash: dialogCtx.hash,
        message,
        thenEdit: dialogCtx.thenEdit,
      });
    }
  };

  function resetGenerateBtn() {
    aiGenerate.disabled = false;
    aiGenerate.textContent = "生成 / 重新生成";
  }

  // ---- messages from extension -------------------------------------------

  window.addEventListener("message", (event) => {
    const m = event.data;
    switch (m.type) {
      case "state":
        state = m;
        render();
        break;
      case "openCompose":
        openDialog(m);
        break;
      case "genDelta":
        dialogText.value += m.text || "";
        dialogText.scrollTop = dialogText.scrollHeight;
        break;
      case "genResult":
        resetGenerateBtn();
        dialogText.value = m.text || dialogText.value;
        break;
      case "genError":
        resetGenerateBtn();
        dialogTitle.textContent = "AI 生成失败：" + m.message;
        break;
      case "genCancelled":
        resetGenerateBtn();
        break;
      case "applySucceeded":
        setDialogApplying(false);
        announce("Commit message 已应用。");
        closeDialog();
        break;
      case "applyFailed":
        setDialogApplying(false);
        setDialogError(m.message || "应用失败，请检查错误并重试。");
        announce(`应用失败：${m.message || "未知错误"}`);
        dialogText.focus();
        break;
      case "detail":
        showDetail(m);
        break;
      case "inlineToast":
        showInlineToast(m.message, m.duration);
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
