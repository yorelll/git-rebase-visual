(function () {
  const vscode = acquireVsCodeApi();

  const listEl = document.getElementById("list");
  const bannerEl = document.getElementById("banner");
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
    if (!directionEl) {
      return;
    }
    directionEl.textContent = dragHint || "↑ Base / 较早（顶部） · ↓ HEAD / 较新（底部）";
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

  function render() {
    renderBanner();
    renderChanges();
    renderList();
  }

  function renderBanner() {
    if (state.rebaseInProgress) {
      bannerEl.className = "banner rebase" + (state.conflictCount ? " conflict" : "");
      const stopped = state.commits && state.commits.find((c) => c.hash === state.stoppedAt);
      const isConflict = state.conflictCount > 0;
      const title = isConflict
        ? `变基暂停：${state.conflictCount} 个文件存在冲突`
        : stopped
          ? `变基停靠 (edit)：${stopped.shortHash} “${stopped.subject}”`
          : "变基进行中，等待继续";
      const guidance = isConflict
        ? `请在编辑器解决并暂存冲突文件：${state.conflictFiles.join("、")}。`
        : stopped
          ? "可修改代码或提交新改动后继续。"
          : "确认工作区状态后继续或 Abort。";
      bannerEl.innerHTML = "";
      const titleEl = document.createElement("div");
      titleEl.className = "banner-title";
      titleEl.textContent = title;
      const guidanceEl = document.createElement("div");
      guidanceEl.textContent = guidance;
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
      const abortButton = document.createElement("button");
      abortButton.className = "btn danger-btn";
      abortButton.id = "b-abort";
      abortButton.textContent = "Abort";
      abortButton.onclick = () => vscode.postMessage({ type: "abortRebase" });
      actions.append(continueButton, abortButton);
      bannerEl.append(titleEl, guidanceEl, actions);
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
      changesEl.appendChild(
        changeBtn(`为暂存区生成并提交（${state.stagedCount || 0} 个文件）`, { mode: "staged", ai: true })
      );
    }
    if (state.hasUnstaged) {
      changesEl.appendChild(
        changeBtn(`为工作区生成并提交（${state.unstagedCount || 0} 个文件，git add -A）`, { mode: "working", ai: true })
      );
    }
  }

  function changeBtn(text, ctx) {
    const b = document.createElement("button");
    b.className = "btn small";
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

  function renderList() {
    listEl.innerHTML = "";
    if (!state.commits || state.commits.length === 0) {
      const d = document.createElement("div");
      d.className = "empty";
      d.textContent = "没有可显示的 commit。";
      listEl.appendChild(d);
      return;
    }
    listEl.setAttribute("aria-label", `Commit 时间轴，共 ${state.commits.length} 个 commit，顶部较早，底部较新`);
    const top = document.createElement("div");
    top.className = "timeline-end";
    top.textContent = "↑ Base / 较早";
    listEl.appendChild(top);
    for (const c of state.commits) {
      listEl.appendChild(commitRow(c));
    }
    const bottom = document.createElement("div");
    bottom.className = "timeline-end";
    bottom.textContent = "↓ HEAD / 较新";
    listEl.appendChild(bottom);
  }

  function commitRow(c) {
    const row = document.createElement("div");
    const stopped = state.stoppedAt && c.hash === state.stoppedAt;
    const index = state.commits.indexOf(c) + 1;
    row.className =
      "commit" + (c.locked ? " locked" : "") + (stopped ? " stopped" : "");
    row.draggable = !state.rebaseInProgress;
    row.dataset.hash = c.hash;
    row.tabIndex = 0;
    row.setAttribute("role", "listitem");
    row.setAttribute(
      "aria-label",
      `第 ${index} 个，共 ${state.commits.length} 个，${c.subject}，${c.shortHash}，${c.author}，${c.date}${c.locked ? "，已锁定" : ""}${stopped ? "，变基停靠于此" : ""}`
    );

    const grip = document.createElement("span");
    grip.className = "grip";
    grip.textContent = "⋮⋮";
    grip.title = "拖拽重排；顶部较早，底部较新";
    grip.setAttribute("aria-hidden", "true");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.setAttribute("aria-hidden", "true");

    const content = document.createElement("div");
    content.className = "commit-content";
    const subject = document.createElement("span");
    subject.className = "subject";
    subject.textContent = c.subject;
    const meta = document.createElement("span");
    meta.className = "commit-meta";
    meta.textContent = `${c.shortHash} · ${c.author} · ${c.date}`;
    content.append(subject, meta);
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

    row.addEventListener("dragstart", (e) => {
      dragHash = c.hash;
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      dragHint = `正在移动 ${c.shortHash}；顶部为较早，底部为较新`;
      renderDirection();
      hideTooltip();
    });
    row.addEventListener("dragend", () => {
      dragHash = null;
      row.classList.remove("dragging");
      clearDropMarkers();
      clearDragHint();
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      clearDropMarkers();
      const after = isAfter(e, row);
      row.classList.add(after ? "drop-after" : "drop-before");
      setDragHint(c, after);
    });
    row.addEventListener("drop", (e) => {
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
      openMenu(e.clientX, e.clientY, c);
    });
    row.addEventListener("keydown", (e) => {
      if ((e.key === "ContextMenu") || (e.shiftKey && e.key === "F10")) {
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        openMenu(rect.left + 8, rect.bottom, c);
      }
    });

    // hover tooltip
    row.addEventListener("mouseenter", () => scheduleTooltip(c, row));
    row.addEventListener("mouseleave", () => cancelTooltip(c.hash));

    return row;
  }

  function clearDropMarkers() {
    document
      .querySelectorAll(".commit.drop-before, .commit.drop-after")
      .forEach((el) => el.classList.remove("drop-before", "drop-after"));
  }

  // True when the cursor is in the lower half of the row (insert AFTER it).
  function isAfter(e, row) {
    const r = row.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2;
  }

  // ---- reorder ------------------------------------------------------------

  function reorder(fromHash, targetHash, after) {
    const order = state.commits.map((c) => c.hash);
    const fromIdx = order.indexOf(fromHash);
    if (fromIdx >= 0) {
      order.splice(fromIdx, 1);
    }
    let targetIdx = order.indexOf(targetHash);
    if (after) {
      targetIdx += 1; // insert below the target (enables moving to the very end)
    }
    order.splice(targetIdx, 0, fromHash);

    const byHash = new Map(state.commits.map((c) => [c.hash, c]));
    state.commits = order.map((h) => byHash.get(h));
    renderList();

    vscode.postMessage({ type: "reorder", order });
  }

  // ---- context menu -------------------------------------------------------

  function openMenu(x, y, c) {
    hideTooltip();
    menuEl.innerHTML = "";
    menuEl.setAttribute("role", "menu");
    const header = document.createElement("div");
    header.className = "menu-header";
    header.textContent = `${c.shortHash} · ${c.subject}`;
    header.title = c.subject;
    menuEl.append(header, menuSeparator());

    menuEl.append(menuGroupLabel("查看"));
    menuEl.append(menuItem({ label: "复制 commit hash", action: () => send("copyHash", c) }));
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
    menuEl.querySelector("button:not(.disabled)")?.focus();
  }

  function closeMenu() {
    menuEl.classList.add("hidden");
    menuEl.innerHTML = "";
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

  function openDialog(m) {
    dialogCtx = {
      mode: m.mode,
      hash: m.hash,
      thenEdit: m.thenEdit === true,
      ai: m.ai === true,
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
    vscode.postMessage({
      type: "apply",
      mode: dialogCtx.mode,
      hash: dialogCtx.hash,
      message,
      thenEdit: dialogCtx.thenEdit,
    });
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
    }
  });

  vscode.postMessage({ type: "ready" });
})();
