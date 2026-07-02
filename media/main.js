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

  let state = { commits: [], rebaseInProgress: false, llmConfigured: false };
  let dragHash = null;
  let dialogCtx = null;

  // ---- rendering ----------------------------------------------------------

  function render() {
    renderBanner();
    renderChanges();
    renderList();
  }

  function renderBanner() {
    if (state.rebaseInProgress) {
      bannerEl.className = "banner rebase";
      bannerEl.innerHTML =
        "变基进行中。如有冲突请在编辑器中解决后：" +
        '<div class="banner-actions">' +
        '<button class="btn primary" id="b-continue">Continue</button>' +
        '<button class="btn" id="b-abort">Abort</button>' +
        "</div>";
      bannerEl.classList.remove("hidden");
      document.getElementById("b-continue").onclick = () =>
        vscode.postMessage({ type: "continueRebase" });
      document.getElementById("b-abort").onclick = () =>
        vscode.postMessage({ type: "abortRebase" });
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
    if (!state.llmConfigured || (!state.hasStaged && !state.hasUnstaged)) {
      changesEl.classList.add("hidden");
      return;
    }
    changesEl.classList.remove("hidden");
    const label = document.createElement("div");
    label.className = "changes-label";
    label.textContent = "未提交的改动";
    changesEl.appendChild(label);
    if (state.hasStaged) {
      changesEl.appendChild(
        changeBtn("为暂存区生成并提交", { mode: "staged", ai: true })
      );
    }
    if (state.hasUnstaged) {
      changesEl.appendChild(
        changeBtn("为工作区生成并提交", { mode: "working", ai: true })
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
    for (const c of state.commits) {
      listEl.appendChild(commitRow(c));
    }
  }

  function colorFor(hash) {
    let h = 0;
    for (let i = 0; i < hash.length; i++) {
      h = (h * 31 + hash.charCodeAt(i)) % 360;
    }
    return h;
  }

  function commitRow(c) {
    const row = document.createElement("div");
    const stopped = state.stoppedAt && c.hash === state.stoppedAt;
    row.className =
      "commit" + (c.locked ? " locked" : "") + (stopped ? " stopped" : "");
    row.draggable = !state.rebaseInProgress;
    row.dataset.hash = c.hash;

    const hue = colorFor(c.hash);
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = `hsl(${hue}, 65%, 55%)`;

    const hash = document.createElement("span");
    hash.className = "hash";
    hash.style.color = `hsl(${hue}, 60%, 60%)`;
    hash.textContent = c.shortHash;
    row.appendChild(dot);

    const subject = document.createElement("span");
    subject.className = "subject";
    subject.textContent = c.subject;

    row.appendChild(hash);
    row.appendChild(subject);

    if (c.locked) {
      const lock = document.createElement("span");
      lock.className = "lock-icon";
      lock.textContent = "🔒";
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
      hideTooltip();
    });
    row.addEventListener("dragend", () => {
      dragHash = null;
      row.classList.remove("dragging");
      clearDropMarkers();
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      clearDropMarkers();
      row.classList.add("drop-before");
    });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drop-before");
      if (dragHash && dragHash !== c.hash) {
        reorder(dragHash, c.hash);
      }
    });

    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, c);
    });

    // hover tooltip
    row.addEventListener("mouseenter", () => scheduleTooltip(c, row));
    row.addEventListener("mouseleave", () => cancelTooltip(c.hash));

    return row;
  }

  function clearDropMarkers() {
    document
      .querySelectorAll(".commit.drop-before")
      .forEach((el) => el.classList.remove("drop-before"));
  }

  // ---- reorder ------------------------------------------------------------

  function reorder(fromHash, beforeHash) {
    const order = state.commits.map((c) => c.hash);
    const fromIdx = order.indexOf(fromHash);
    if (fromIdx >= 0) {
      order.splice(fromIdx, 1);
    }
    const targetIdx = order.indexOf(beforeHash);
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
    const items = [
      { label: "复制 commit hash", action: () => send("copyHash", c) },
      { sep: true },
      { label: "变基到此 commit", action: () => send("rebaseTo", c) },
      { sep: true },
      {
        label: "更改此 commit message",
        action: () =>
          vscode.postMessage({ type: "openCompose", mode: "commit", hash: c.hash, ai: false, thenEdit: false }),
      },
      {
        label: "更改 message 并变基至此",
        action: () =>
          vscode.postMessage({ type: "openCompose", mode: "commit", hash: c.hash, ai: false, thenEdit: true }),
      },
      {
        label: "为此 commit 生成 AI message",
        disabled: !state.llmConfigured,
        action: () =>
          vscode.postMessage({ type: "openCompose", mode: "commit", hash: c.hash, ai: true, thenEdit: false }),
      },
      { sep: true },
      c.locked
        ? { label: "解除锁定", action: () => send("unlock", c) }
        : { label: "锁定 commit", action: () => send("lock", c) },
      { label: "删除 commit", action: () => send("drop", c) },
    ];

    for (const it of items) {
      if (it.sep) {
        const s = document.createElement("div");
        s.className = "sep";
        menuEl.appendChild(s);
        continue;
      }
      const el = document.createElement("div");
      el.className = "item" + (it.disabled ? " disabled" : "");
      el.textContent = it.label;
      if (!it.disabled) {
        el.onclick = () => {
          closeMenu();
          it.action();
        };
      }
      menuEl.appendChild(el);
    }

    menuEl.classList.remove("hidden");
    const mw = menuEl.offsetWidth;
    const mh = menuEl.offsetHeight;
    menuEl.style.left = Math.min(x, window.innerWidth - mw - 4) + "px";
    menuEl.style.top = Math.min(y, window.innerHeight - mh - 4) + "px";
  }

  function closeMenu() {
    menuEl.classList.add("hidden");
  }

  function send(type, c) {
    vscode.postMessage({ type, hash: c.hash });
  }

  document.addEventListener("click", closeMenu);
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
    meta.textContent = `${d.author} · ${d.relDate} (${d.absDate})`;
    const stat = document.createElement("div");
    stat.className = "tip-stat";
    stat.textContent = `${d.hash.slice(0, 10)}   ${d.stat || ""}`;
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
    let top = r.bottom + 4;
    if (top + th > window.innerHeight) {
      top = Math.max(4, r.top - th - 4);
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
    dialogEl.classList.add("hidden");
    dialogCtx = null;
  }

  origCopy.onclick = () =>
    vscode.postMessage({ type: "copyText", text: origText.value });

  aiGenerate.onclick = () => {
    if (!dialogCtx) {
      return;
    }
    aiGenerate.disabled = true;
    aiGenerate.textContent = "生成中…";
    vscode.postMessage({
      type: "generate",
      mode: dialogCtx.mode,
      hash: dialogCtx.hash,
      extra: aiExtra.value,
    });
  };

  dialogCancel.onclick = closeDialog;

  dialogOk.onclick = () => {
    if (!dialogCtx) {
      return;
    }
    const message = dialogText.value.trim();
    if (message.length === 0) {
      return;
    }
    vscode.postMessage({
      type: "apply",
      mode: dialogCtx.mode,
      hash: dialogCtx.hash,
      message,
      thenEdit: dialogCtx.thenEdit,
    });
    closeDialog();
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
      case "genResult":
        resetGenerateBtn();
        dialogText.value = m.text || "";
        break;
      case "genError":
        resetGenerateBtn();
        dialogTitle.textContent = "AI 生成失败：" + m.message;
        break;
      case "detail":
        showDetail(m);
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
