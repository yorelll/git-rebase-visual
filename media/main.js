(function () {
  const rawVsCode = acquireVsCodeApi();
  // Every webview-to-host message carries an action source. The host records it
  // for diagnostics but only explicit Git-writing actions can raise a paused
  // rebase warning.
  const sourceForAction = (type) => {
    if (["reorder"].includes(type)) return "webview:reorder";
    if (["stageFile", "restoreFile", "stageAllFiles", "discardAllFiles", "unstageAllFiles"].includes(type)) return "webview:worktree-mutation";
    if (["requestDetail", "openDiff", "generateDiff", "bulkGenerateDiff", "openWorktreeDiff", "copyHash", "copyMessage", "copyText"].includes(type)) return "webview:read";
    if (["ready", "refresh"].includes(type)) return "webview:lifecycle";
    return "webview:ui";
  };
  const vscode = {
    postMessage(message) { return rawVsCode.postMessage({ ...message, source: message.source || sourceForAction(message.type) }); },
    getState: () => rawVsCode.getState(),
    setState: (value) => rawVsCode.setState(value),
  };
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
  // `state.commits` starts as the bootstrap default [], which is indistinguishable
  // from a repo that genuinely has no commits. The host's first refresh awaits a
  // dozen Git calls, so that window is seconds long on a real repo: say "loading",
  // not "no commits", until the first state message actually arrives.
  let stateLoaded = false;
  let drag = null;
  let dragHint = "";
  let filterText = "";
  let selectedHashes = new Set();
  let selectionAnchor = null;
  // Keyboard pickup is a drag session too: keep its immutable canonical
  // snapshot until Enter/Escape rather than reinterpreting it after refresh.
  let keyboardPickup = null;
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
  // After a tooltip that was actually on screen is dismissed, the next hover is
  // almost certainly the user moving down the timeline. Skip the 400ms
  // anti-misfire delay during that window so browsing rows does not pay the
  // delay on every row.
  let tipInstantUntil = 0;
  let isComposingInput = false;

  function announce(message) {
    const live = document.getElementById("live");
    if (live) live.textContent = message;
  }

  // ------------------------------------------------------------ focus identity
  // A 1.5s status poll can resend the same state, and a real one rebuilds
  // `#banner`, `#changes` and `#list` with `innerHTML = ""`. Replacing the
  // focused element drops keyboard focus to <body>: the next Alt+↓ goes
  // nowhere, Ctrl+Space loses the row, and a banner action stops working after
  // one refresh. Capture a *stable identity* before the teardown and re-find
  // the equivalent element afterwards. A node reference is deliberately not
  // used — it points at the removed element. `document.hasFocus()` is the
  // guard: a background webview must never steal focus back from the editor.
  function focusIdentityFor(el) {
    if (!el || el === document.body || el === document.documentElement) return null;
    // The search box owns its own selection restore (captureSearchFocus); do
    // not compete with it here.
    if (el.classList?.contains("commit-search")) return null;
    if (el === bannerEl) return { kind: "banner" };
    const commit = el.closest?.(".commit");
    if (commit?.dataset.hash) return { kind: "commit", hash: commit.dataset.hash };
    const changeRow = el.closest?.(".change-file");
    if (changeRow) {
      const identity = { path: changeRow.dataset.path, group: changeRow.dataset.group };
      if (el === changeRow) return { kind: "change-row", ...identity };
      if (el.dataset?.action) return { kind: "change-action", ...identity, action: el.dataset.action };
      return { kind: "change-row", ...identity };
    }
    if (el.closest?.("#banner") && el.dataset?.action) return { kind: "banner-action", action: el.dataset.action };
    if (el.dataset?.action) return { kind: "action", action: el.dataset.action };
    return null;
  }
  function captureFocusIdentity() {
    // `hasFocus` reports whether the webview itself is the focused document.
    // When it is false (the user is typing in the editor next door) a poll must
    // not pull focus into the sidebar.
    if (typeof document.hasFocus === "function" && !document.hasFocus()) return null;
    return focusIdentityFor(document.activeElement);
  }
  function findByData(el, key, value) {
    return [...el.querySelectorAll("[data-" + key + "]")].find((candidate) => candidate.dataset[key] === value) || null;
  }
  function focusTargetFor(identity) {
    if (identity.kind === "commit") return [...listEl.querySelectorAll(".commit")].find((row) => row.dataset.hash === identity.hash) || null;
    if (identity.kind === "banner") return bannerEl.hasAttribute("tabindex") ? bannerEl : null;
    if (identity.kind === "banner-action") return findByData(bannerEl, "action", identity.action);
    if (identity.kind === "change-row" || identity.kind === "change-action") {
      const row = [...changesEl.querySelectorAll(".change-file")]
        .find((candidate) => candidate.dataset.path === identity.path && candidate.dataset.group === identity.group);
      if (!row) return null;
      if (identity.kind === "change-row") return row;
      return findByData(row, "action", identity.action);
    }
    if (identity.kind === "action") {
      const found = findByData(document, "action", identity.action);
      if (found) return found;
      // A group-level change action (stage/discard all) has no row scope.
      return null;
    }
    return null;
  }
  function restoreFocusIdentity(identity) {
    if (!identity) return;
    const target = focusTargetFor(identity);
    if (target) {
      // `preventScroll` keeps a restored row where the user left it; the browser
      // already scrolled it into view when it first received focus.
      target.focus?.({ preventScroll: true });
      return;
    }
    // The target no longer exists (the row was deleted or filtered out). Land
    // on the list's own search control when one is rendered; otherwise leave
    // focus wherever the rebuild put it (body) rather than throwing.
    const fallback = listEl.querySelector(".commit-search");
    fallback?.focus?.({ preventScroll: true });
  }
  // utf-8 JSON of the host state. Used to prove that an identical poll is a
  // no-op: rebuilding the same DOM is both wasted work and a live-region churn.
  function stateSignature(value) {
    try { return JSON.stringify(value); } catch { return null; }
  }
  let lastStateSignature = null;

  function short(hash) { return (hash || "").slice(0, 8); }
  function setDragHint(message) { dragHint = message; renderDirection(); }
  function clearDragHint() { dragHint = ""; renderDirection(); }
  // The copy must not claim reordering is available when the conditions that
  // gate a drag say it is not, and must not claim an empty timeline before the
  // first state arrives. Priority: a live drag hint wins, then the pre-state
  // loading copy, then the rebase lock, then an empty timeline (renderList()
  // returns before rendering the search controls, so an empty list must not
  // point at them), then an active filter, then the discovery copy.
  // canStartDrag() gates the drag itself; this copy also has to stay truthful
  // before any state exists, which canStartDrag() never has to consider.
  function directionHint() {
    if (dragHint) return dragHint;
    if (!stateLoaded) return "正在加载 commit…";
    if (state.rebaseInProgress) return "变基进行中 · 重排已禁用";
    if (!(state.commits ?? []).length) return "没有可重排的 commit";
    if (isFilterActive()) return "过滤中无法重排 · 清空搜索后可用 ⋮⋮";
    return "拖动 ⋮⋮ 重排 · Alt+↑↓ 移动一位";
  }
  function renderDirection() {
    // The row sits between #changes and #list and stays in the document flow.
    // Showing it for the first time on pointerdown used to push the whole commit
    // list down, so the row under the cursor changed at the instant the drag
    // started. Keep it resident and swap only its text.
    //
    // The template gives this element role="status" and aria-live="polite". The
    // idle copy is discovery text, not a status update: leaving it live would
    // make endDrag() announce the static copy again, on top of the #live
    // completion announcement, and could announce it on startup too. An explicit
    // aria-live="off" overrides the implicit polite of role="status"; turn it
    // back on only for the duration of a drag, where target changes must speak.
    const live = dragHint ? "polite" : "off";
    if (directionEl.getAttribute("aria-live") !== live) directionEl.setAttribute("aria-live", live);
    // Writing the same text still replaces the text node and mutates the live
    // region; only write when the copy actually changed.
    const next = directionHint();
    if (directionEl.textContent !== next) directionEl.textContent = next;
    directionEl.classList.remove("hidden");
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
    // Banner changes and the list rebuild both destroy focus. Capture once here
    // so a focus target in an earlier region survives every later region; the
    // per-region rebuilds also restore on their own for direct calls.
    const focus = captureFocusIdentity();
    renderBanner(); renderContext(); renderChanges(); renderList(); restoreSearchFocus();
    restoreFocusIdentity(focus);
  }
  function renderContext() {
    if (!state.branchName) { contextEl.classList.add("hidden"); return; }
    // Keep the stable branch text in a child: the toast is an absolute overlay,
    // not a sibling inserted before the list, so document flow never changes.
    // `upstreamNote` replaces the arrow counts rather than sitting beside them.
    // Showing "↑0 ↓0" next to "cannot compute the range" is the defect this
    // note exists to remove: 0/0 reads as "in sync" and would win.
    const counters = state.upstreamNote
      ? `↑? ↓? · ${state.upstreamNote}`
      : `↑${state.aheadCount || 0} ↓${state.behindCount || 0}`;
    const next = `${state.branchName} · ${state.upstreamRef} · ${counters} · ${state.rangeLabel || ""}`;
    if (contextTextEl.textContent !== next) contextTextEl.textContent = next;
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
    // Stable identity for focus restoration across a refresh; the label is
    // localized copy, the action is a fixed key.
    if (options.action) b.dataset.action = options.action;
    if (!b.disabled) b.onclick = onClick;
    return b;
  }

  // Everything the banner paints, as one comparable string. `renderBanner` is
  // the first region every state message touches and `#banner` is
  // `role="status" aria-live="polite"`, so rebuilding identical content both
  // wastes a frame and makes a screen reader announce the same error every
  // 1.5s. Only a changed key may touch `innerHTML`/`textContent`.
  function bannerRenderKey() {
    if (!state.rebaseInProgress) {
      if (state.error) return `error\u0000${state.error}`;
      if (state.recoveryNotice) return `recovery\u0000${state.recoveryNotice}`;
      return "hidden";
    }
    const stopped = (state.commits ?? []).find((c) => c.hash === state.stoppedAt);
    const isConflict = state.conflictCount > 0;
    const isEditStop = state.pausedReason === "edit" && !!stopped;
    return JSON.stringify([
      "rebase",
      isConflict,
      isConflict ? state.conflictCount : null,
      isConflict ? state.conflictFiles ?? [] : null,
      isEditStop ? stopped.hash : null,
      isEditStop ? stopped.subject : null,
      state.totalSteps ?? null,
      state.completedSteps || 0,
      isEditStop ? state.stagedCount || 0 : null,
      isEditStop ? state.unstagedCount || 0 : null,
      isEditStop ? !!state.hasStaged : null,
    ]);
  }
  let lastBannerKey = null;
  // The banner is a scroll container, not a natural tab stop. Give it
  // `tabindex="0"` only while it actually overflows (`scrollHeight >
  // clientHeight`), so PageDown can scroll the diagnostic text; remove it
  // again when the content fits, otherwise every banner steals a Tab press.
  // Re-evaluated after each rebuild and on resize.
  function updateBannerFocusability() {
    if (bannerEl.classList.contains("hidden")) {
      if (bannerEl.hasAttribute("tabindex")) bannerEl.removeAttribute("tabindex");
      return;
    }
    const scrollable = bannerEl.scrollHeight > bannerEl.clientHeight;
    if (scrollable) {
      if (bannerEl.getAttribute("tabindex") !== "0") bannerEl.setAttribute("tabindex", "0");
    } else if (bannerEl.hasAttribute("tabindex")) {
      bannerEl.removeAttribute("tabindex");
    }
  }

  function renderBanner() {
    const key = bannerRenderKey();
    if (key === lastBannerKey) {
      // Same content: leave the live region and its buttons untouched. Focus
      // inside it therefore survives the poll without any restoration work.
      updateBannerFocusability();
      return;
    }
    lastBannerKey = key;
    const focus = captureFocusIdentity();
    bannerEl.innerHTML = "";
    if (!state.rebaseInProgress) {
      if (state.error) { bannerEl.className = "banner error"; bannerEl.textContent = state.error; bannerEl.classList.remove("hidden"); }
      else if (state.recoveryNotice) {
        // Persistent, dismissible recovery banner. The commit list stays usable
        // underneath: a stale bookkeeping record must never hide history.
        bannerEl.className = "banner recovery";
        const titleEl = document.createElement("div"); titleEl.className = "banner-title"; titleEl.textContent = "待恢复的改动";
        const textEl = document.createElement("div"); textEl.textContent = state.recoveryNotice;
        const actions = document.createElement("div"); actions.className = "banner-actions";
        actions.append(
          button("打开日志", () => vscode.postMessage({ type: "openLogs" }), { action: "open-logs" }),
          button("关闭提示", () => vscode.postMessage({ type: "dismissRecoveryNotice" }), { action: "dismiss-recovery" })
        );
        bannerEl.append(titleEl, textEl, actions);
        bannerEl.classList.remove("hidden");
      }
      else bannerEl.classList.add("hidden");
      updateBannerFocusability();
      restoreFocusIdentity(focus);
      return;
    }
    // `state.commits ?? []` for the same reason as in `renderList`: the
    // `rebaseInProgress` error states from `resolveRange` / `getCommits` carry no
    // commit list. This one is worse than the list throwing: `renderBanner` is
    // the FIRST thing `render()` does, so a throw here happens before any error
    // text is painted and leaves the user looking at an empty banner with no
    // error at all.
    const stopped = (state.commits ?? []).find((c) => c.hash === state.stoppedAt);
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
        button(amendLabel, () => vscode.postMessage({ type: "openCompose", mode: "commit", hash: stopped.hash, ai: false, thenEdit: true, editKind: "amend" }), { primary: true, disabled: !state.hasStaged, action: "amend-commit", title: state.hasStaged ? "编辑 message 后 amend 当前 edit commit" : "请先在 SCM 中暂存改动。" }),
        button("新建 commit…", () => vscode.postMessage({ type: "openCompose", mode: "staged", ai: false, thenEdit: false, editKind: "new" }), { disabled: !state.hasStaged, action: "new-commit", title: state.hasStaged ? "创建新 commit；变基暂停时不调用 AI。" : "请先在 SCM 中暂存改动。" })
      );
      bannerEl.appendChild(editActions);
    }
    const actions = document.createElement("div"); actions.className = "banner-actions";
    actions.appendChild(button("Continue", () => vscode.postMessage({ type: "continueRebase" }), { primary: true, disabled: isConflict, action: "continue-rebase", title: isConflict ? `还有 ${state.conflictCount} 个文件未解决；解决并暂存后才能 Continue。` : "" }));
    if (isConflict) actions.appendChild(button("Skip（丢弃 patch）", () => vscode.postMessage({ type: "skipRebase" }), { danger: true, action: "skip-rebase" }));
    actions.appendChild(button("Abort", () => vscode.postMessage({ type: "abortRebase" }), { danger: true, action: "abort-rebase" }));
    bannerEl.appendChild(actions);
    bannerEl.classList.remove("hidden");
    updateBannerFocusability();
    restoreFocusIdentity(focus);
  }

  function changeState(kind) {
    return ({ modify: { mark: "M", label: "已修改" }, add: { mark: "A", label: "已添加" }, delete: { mark: "D", label: "已删除" }, rename: { mark: "R", label: "已重命名" }, untracked: { mark: "U", label: "未跟踪" }, unmerged: { mark: "U", label: "存在冲突" } })[kind] || { mark: "M", label: "已修改" };
  }
  function fileNameAndPath(filePath) {
    const normalized = String(filePath || "").replace(/\\\\/g, "/");
    const at = normalized.lastIndexOf("/");
    return at < 0 ? { name: normalized, parent: "" } : { name: normalized.slice(at + 1), parent: normalized.slice(0, at + 1) };
  }
  function changeAction(icon, title, onClick) {
    const action = document.createElement("button");
    action.type = "button"; action.className = "btn file-action"; action.textContent = icon;
    action.title = title; action.setAttribute("aria-label", title);
    // Stable focus key; the visible glyph and localized label may change.
    action.dataset.action = title;
    action.addEventListener("pointerdown", (event) => event.stopPropagation());
    action.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
    return action;
  }
  function appendChangeFiles(parent, changes) {
    const staged = changes.filter((change) => change.staged);
    const unstaged = changes.filter((change) => change.unstaged);
    const appendGroup = (title, items, side) => {
      if (!items.length) return;
      const header = document.createElement("div"); header.className = "file-group-header";
      const label = document.createElement("div"); label.className = "file-group-label"; label.textContent = `${title} (${items.length})`; header.appendChild(label);
      const groupActions = document.createElement("span"); groupActions.className = "file-group-actions";
      if (side === "unstaged") {
        groupActions.append(
          changeAction("+", "暂存全部更改", () => vscode.postMessage({ type: "stageAllFiles" })),
          changeAction("↶", "恢复全部更改", () => vscode.postMessage({ type: "discardAllFiles" }))
        );
      } else {
        groupActions.append(
          changeAction("↶", "撤销全部暂存", () => vscode.postMessage({ type: "unstageAllFiles" })),
          changeAction("✦", "AI 生成 message 并提交暂存区", () => vscode.postMessage({ type: "openCompose", mode: "staged", ai: true, thenEdit: false }))
        );
      }
      header.appendChild(groupActions); parent.appendChild(header);
      items.forEach((change) => {
        const row = document.createElement("div"); row.className = "change-file"; row.tabIndex = 0;
        // The same path can appear once per group (staged and unstaged), so the
        // focus key is path + group, never the path alone.
        row.dataset.path = change.path; row.dataset.group = side;
        const kind = side === "staged" ? change.indexKind : change.worktreeKind;
        const visual = changeState(kind);
        const status = document.createElement("span"); status.className = `file-state file-state-${kind || "modify"}`; status.textContent = visual.mark; status.title = visual.label; status.setAttribute("aria-label", visual.label);
        const target = document.createElement("button"); target.type = "button"; target.className = "file-open"; target.title = change.path; target.setAttribute("aria-label", `打开 Diff：${change.path}`); target.dataset.action = "open-diff";
        const pieces = fileNameAndPath(change.path); const name = document.createElement("span"); name.className = "file-name"; name.textContent = pieces.name; const parentPath = document.createElement("span"); parentPath.className = "file-path"; parentPath.textContent = pieces.parent; target.append(name, parentPath); target.onclick = () => vscode.postMessage({ type: "openWorktreeDiff", path: change.path });
        const actions = document.createElement("span"); actions.className = "file-actions";
        if (side === "unstaged" && !change.conflicted) actions.append(changeAction("+", "暂存此文件", () => vscode.postMessage({ type: "stageFile", path: change.path })));
        if (!change.conflicted && !(side === "unstaged" && kind === "untracked")) {
          actions.append(changeAction("↶", side === "staged" ? "撤销此文件的暂存" : "恢复此文件的工作区改动", () => requestRestore(change, side)));
        } else if (side === "unstaged" && kind === "untracked") {
          actions.append(changeAction("⌫", "删除未跟踪文件", () => requestRestore(change, side)));
        }
        row.append(status, target, actions); parent.appendChild(row);
      });
    };
    appendGroup("Staged Changes", staged, "staged");
    appendGroup("Changes", unstaged, "unstaged");
  }
  function requestRestore(change, side) {
    // The extension host owns the authoritative modal after a fresh porcelain
    // read. Avoid a second webview confirm: it previously made action clicks look
    // inert and could race with a status refresh before the host received them.
    //
    // `side` here is this panel's group key ("staged"/"unstaged"); the host's
    // vocabulary is "staged"/"working" (restoreWorktreeChange). Posting the
    // group key unchanged made the host reject every Changes-side restore with
    // 缺少要恢复的文件状态, so translate at the message boundary rather than
    // teaching the host a second alias.
    const restoreSide = side === "staged" ? "staged" : "working";
    const untracked = restoreSide === "working" && change.worktreeKind === "untracked";
    vscode.postMessage({ type: "restoreFile", path: change.path, side: restoreSide, deleteUntracked: untracked });
  }
  // Everything `renderChanges()` paints. A poll can carry an unrelated field
  // change (undo bookkeeping, presentation counts) while this region is
  // identical; rebuilding it would churn focus and mutations for nothing.
  function changesRenderKey() {
    if (!state.hasStaged && !state.hasUnstaged) return "hidden";
    return JSON.stringify([
      !!state.hasStaged, !!state.hasUnstaged,
      state.stagedCount || 0, state.unstagedCount || 0,
      !!state.llmConfigured, !!state.rebaseInProgress, state.pausedReason ?? null,
      // `changesMoreOpen` is not part of the key: it is persisted UI state that
      // the `<details>` element already reflects natively. Including it makes
      // the programmatic `open` write fire a toggle event that changes the key
      // and forces a redundant rebuild on the next poll.
      (state.changes || []).map((change) => [change.path, change.indexKind ?? null, change.worktreeKind ?? null, !!change.staged, !!change.unstaged, !!change.conflicted]),
    ]);
  }
  let lastChangesKey = null;
  function renderChanges() {
    const key = changesRenderKey();
    if (key === lastChangesKey) return;
    lastChangesKey = key;
    changesEl.innerHTML = "";
    if (!state.hasStaged && !state.hasUnstaged) { changesEl.classList.add("hidden"); return; }
    changesEl.classList.remove("hidden");
    const label = document.createElement("div"); label.className = "changes-label";
    label.textContent = `未提交的改动：${[state.hasStaged ? `${state.stagedCount || 0} 个暂存文件` : "", state.hasUnstaged ? `${state.unstagedCount || 0} 个工作区文件` : ""].filter(Boolean).join(" · ")}`;
    changesEl.appendChild(label);
    const atEditStop = state.rebaseInProgress && state.pausedReason === "edit";
    if (!atEditStop && !state.llmConfigured) {
      const hint = document.createElement("div"); hint.className = "changes-hint"; hint.textContent = "配置 LLM 后可生成 AI commit message。";
      changesEl.append(hint, button("打开 LLM 设置", () => vscode.postMessage({ type: "openLlmSettings" }), { action: "open-llm-settings" }));
    }
    const more = document.createElement("details"); more.className = "changes-more"; more.open = changesMoreOpen || atEditStop;
    more.addEventListener("toggle", () => { changesMoreOpen = more.open; persistUi(); });
    const summary = document.createElement("summary"); summary.textContent = atEditStop ? "本次 edit stop 的文件" : "更多提交选项"; summary.dataset.action = "changes-more"; more.appendChild(summary);
    appendChangeFiles(more, state.changes || []);
    changesEl.appendChild(more);
  }
  function changeButton(text, ctx) {
    return button(text, () => vscode.postMessage({ type: "openCompose", mode: ctx.mode, ai: ctx.ai, thenEdit: false }), { primary: ctx.primary });
  }

  function parseSearch(raw) {
    const query = raw.trim(); if (!query) return [];
    const markers = [...query.matchAll(/(?:^|\s)(author|msg|hash):\s*/gi)];
    if (!markers.length) return query.split(/\s+/).filter(Boolean).map((value) => ({ field: "text", value: value.toLowerCase() }));
    const terms = []; const appendText = (value) => value.trim().split(/\s+/).filter(Boolean).forEach((token) => terms.push({ field: "text", value: token.toLowerCase() }));
    appendText(query.slice(0, markers[0].index));
    markers.forEach((marker, index) => { const field = marker[1].toLowerCase(); const start = marker.index + marker[0].length; const end = index + 1 < markers.length ? markers[index + 1].index : query.length; let value = query.slice(start, end).trim().toLowerCase(); if (!value) { appendText(`${field}:`); return; } if (field === "hash" && /^0x[0-9a-f]+$/i.test(value)) value = value.slice(2); terms.push({ field, value }); });
    return terms;
  }
  function queryMatch(c, raw) {
    return parseSearch(raw).every((term) => {
      if (term.field === "hash") return c.hash.toLowerCase().startsWith(term.value) || c.shortHash.toLowerCase().startsWith(term.value);
      if (term.field === "author") return `${c.author} ${c.authorEmail}`.toLowerCase().includes(term.value);
      if (term.field === "msg") return c.subject.toLowerCase().includes(term.value);
      return [c.shortHash, c.hash, c.subject, c.author, c.authorEmail, c.date].join(" ").toLowerCase().includes(term.value);
    });
  }
  // No `?? []` here on purpose: the only caller is `renderList`, which returns
  // early when `commits` is empty or absent, so `state.commits` is a non-empty
  // array by the time this runs. A guard here would be unreachable.
  function filteredCommits() { return state.commits.filter((c) => queryMatch(c, filterText)); }
  function isFilterActive() { return filterText.trim().length > 0; }
  function commitIsPending(c) { return (state.pendingHashes || []).some((hash) => c.hash.startsWith(hash) || hash.startsWith(c.hash)); }
  function commitIsStopped(c) { return state.pausedReason === "edit" && state.stoppedAt === c.hash; }
  function isUnsafeToCollapse(c) {
    // Pending locked commits remain safe to summarize: the summary states that
    // they will replay, and all reordering remains disabled during a rebase.
    return (state.activeHash && (c.hash.startsWith(state.activeHash) || state.activeHash.startsWith(c.hash))) || commitIsStopped(c) || selectedHashes.has(c.hash);
  }
  function authorIdentity(c) {
    return `${c.author || ""}${c.authorEmail || ""}`.replace(/[^\p{L}\p{N}]/gu, "") || "?";
  }
  function authorLabel(c) {
    const initial = c.authorInitial || "?";
    // In High Contrast, forced colors collapse palette distinctions. Give each
    // distinct same-initial identity its shortest unique text prefix instead of
    // relying on its palette key (or a fixed two-character prefix that can also
    // collide, e.g. Alice/Alicia).
    const visible = state.commits.filter((item) => (item.authorInitial || "?") === initial);
    const identity = authorIdentity(c);
    const identities = [...new Set(visible.map(authorIdentity))];
    if (identities.length <= 1) return initial;
    for (let length = 2; length <= identity.length; length++) {
      const label = identity.slice(0, length);
      if (identities.every((other) => other === identity || !other.startsWith(label))) return label;
    }
    return identity;
  }
  function lockedRunKey(commits) { return commits.map((c) => c.hash).join(":"); }
  function compactAuthor(name) {
    const normalized = String(name || "?").trim();
    return normalized.slice(0, 2) || "?";
  }
  function runSummary(commits) {
    const authors = new Map();
    commits.forEach((c) => authors.set(c.author, (authors.get(c.author) || 0) + 1));
    const authorText = [...authors].map(([name, count]) => `${compactAuthor(name)} ×${count}`).join(" · ");
    const pending = commits.some(commitIsPending) ? " · replay" : "";
    return `🔒 : ${commits.length} lock · no push${authorText ? ` · ${authorText}` : ""}${pending}`;
  }
  function runSummaryAria(commits) {
    const authors = new Map();
    commits.forEach((c) => authors.set(c.author || "未知作者", (authors.get(c.author || "未知作者") || 0) + 1));
    // The compact text carries " · replay" for a not-yet-replayed commit, and
    // the individual row labels already announce 待重放; the run's accessible
    // name must not be the one place that drops the fact.
    const pending = commits.some(commitIsPending) ? "；其中包含尚未重放的 commit" : "";
    return `已锁定 ${commits.length} 个 commit，不会被推送${pending}；${[...authors].map(([name, count]) => `${name} ${count} 个`).join("，")}`;
  }

  // Everything `renderList()` paints, including the local selection/filter/
  // keyboard-pickup state that does not live in the host message. Same key =>
  // no rebuild, so an unrelated poll field cannot drop focus or churn rows.
  function listRenderKey() {
    return JSON.stringify([
      stateLoaded,
      !!state.rebaseInProgress,
      state.pausedReason ?? null,
      state.stoppedAt ?? null,
      state.activeHash ?? null,
      !!state.collapseLockedRuns,
      filterText,
      [...selectedHashes].sort(),
      keyboardPickup ? keyboardPickup.sourceHash : null,
      // `expandedLockedRuns` is DOM-owned like `changesMoreOpen`: a toggle
      // already changed the visible `<details>`, and a later rebuild reads the
      // current set. Keeping it here would force a second rebuild after every
      // programmatic open/close.
      (state.commits ?? []).map((c) => [
        c.hash, c.shortHash, c.subject, c.author, c.authorEmail,
        c.authorInitial ?? null, c.authorColorKey ?? null, c.isCurrentAuthor ?? null,
        c.date, !!c.locked,
      ]),
      state.pendingHashes ?? [],
    ]);
  }
  let lastListKey = null;
  function renderList() {
    const key = listRenderKey();
    if (key === lastListKey) return;
    lastListKey = key;
    // `listEl.innerHTML = ""` removes the focused row on every selection,
    // filter edit and Alt+↓ move. Capture first, re-find the row by data-hash at
    // the end; otherwise the second Alt+↓ of a pair lands on <body>.
    const focus = captureFocusIdentity();
    // Every path that can change whether reordering is available funnels through
    // here: a state message calls render() → renderList(), while filter edits,
    // row selection and the clear-search button call renderList() directly. A
    // single choke point at the top keeps the idle copy truthful after both; it
    // must run before the empty-list early return below.
    renderDirection();
    listEl.innerHTML = "";
    // A state posted with an `error` and nothing else — no workspace folder, not
    // a git repo, a failed range/compose query — has no `commits` key at all.
    // Rendering order is banner → context → changes → list, so without this the
    // user sees the banner and then a half-rendered panel plus an uncaught
    // `Cannot read properties of undefined`. Coercing here states the truth: we
    // know of no commits, we did not fail to show any.
    const commits = state.commits ?? [];
    const known = new Set(commits.map((c) => c.hash));
    selectedHashes = new Set([...selectedHashes].filter((h) => known.has(h)));
    if (!commits.length) { const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "没有可显示的 commit。"; listEl.appendChild(empty); restoreFocusIdentity(focus); return; }
    const visible = filteredCommits();
    listEl.setAttribute("role", "listbox");
    listEl.setAttribute("aria-label", `Commit 时间轴，共 ${commits.length} 个 commit，显示 ${visible.length} 个，顶部较早，底部较新`);
    const controls = document.createElement("div"); controls.className = "list-controls";
    const search = document.createElement("input"); search.type = "search"; search.className = "commit-search"; search.placeholder = "搜索 hash、message、作者"; search.value = filterText;
    search.setAttribute("aria-label", "过滤 commit；过滤时禁用重排。支持 author:、hash:、msg:；hash:0x 前缀可省略。");
    // IMEs own the input's composing range. Rendering during composition would
    // replace the element and duplicate/corrupt Chinese input, so commit only
    // after compositionend. The input and its selection remain untouched until then.
    let composing = false;
    let compositionFinalValue = null;
    const applySearch = () => {
      filterText = search.value; keyboardPickup = null; persistUi(); renderList();
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
    if (filterText) controls.appendChild(button("清除", () => { filterText = ""; persistUi(); renderList(); listEl.querySelector(".commit-search")?.focus(); }, { action: "clear-filter" }));
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
    restoreFocusIdentity(focus);
  }

  function lockedRunRow(commits) {
    const key = lockedRunKey(commits); const details = document.createElement("details"); details.className = "locked-run"; details.open = expandedLockedRuns.has(key);
    details.addEventListener("toggle", () => { if (details.open) expandedLockedRuns.add(key); else expandedLockedRuns.delete(key); persistUi(); });
    const summary = document.createElement("summary"); summary.textContent = runSummary(commits); summary.title = runSummaryAria(commits);
    summary.setAttribute("aria-label", `${runSummaryAria(commits)}；拖入上半部插入 run 前，拖入下半部插入 run 后`);
    summary.addEventListener("dragover", (event) => { if (!drag || drag.filter || state.rebaseInProgress) return; event.preventDefault(); const after = isAfter(event, summary); clearDropMarkers(); details.classList.toggle("drop-before", !after); details.classList.toggle("drop-after", after); setDragHint(`将 ${short(drag.sourceHash)} 移动到锁定区 ${after ? "之后" : "之前"}`); });
    summary.addEventListener("dragleave", () => details.classList.remove("drop-before", "drop-after"));
    summary.addEventListener("drop", (event) => {
      if (!drag || drag.filter || state.rebaseInProgress) return;
      event.preventDefault();
      const after = isAfter(event, summary);
      details.classList.remove("drop-before", "drop-after");
      completeDrag({ anchorHash: after ? commits.at(-1).hash : commits[0].hash, after });
    });
    details.appendChild(summary); commits.forEach((c) => details.appendChild(commitRow(c))); return details;
  }

  function commitRow(c) {
    const row = document.createElement("div"); const pending = commitIsPending(c); const stopped = commitIsStopped(c); const selected = selectedHashes.has(c.hash); const index = state.commits.indexOf(c) + 1;
    row.className = `commit${c.locked ? " locked" : ""}${pending ? " pending" : ""}${stopped ? " stopped" : ""}${selected ? " selected" : ""}${keyboardPickup?.sourceHash === c.hash ? " keyboard-pickup" : ""}`;
    row.dataset.hash = c.hash; row.tabIndex = 0; row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(selected));
    row.setAttribute("aria-label", `第 ${index} 项，共 ${state.commits.length} 项，${c.subject}，${short(c.hash)}，${c.author}${c.locked ? "，已锁定" : ""}${pending ? "，待重放" : ""}${stopped ? "，变基停靠于此" : ""}。选择后可按 Alt+上/下 移动一位。`);
    const grip = document.createElement("span"); grip.className = "grip"; grip.textContent = "⋮⋮"; grip.title = isFilterActive() ? "过滤中无法重排，请先清空搜索。" : c.locked ? "已锁定的 commit 不能拖动。" : "拖拽重排；顶部较早，底部较新"; grip.setAttribute("aria-hidden", "true"); grip.draggable = !state.rebaseInProgress && !isFilterActive() && !c.locked;
    const authorDotLabel = authorLabel(c);
    const dot = document.createElement("span"); dot.className = `dot author-${c.authorColorKey || "0"}${authorDotLabel.length > 1 ? " author-label-two" : ""}`; dot.textContent = authorDotLabel; dot.title = `${c.author} <${c.authorEmail || "unknown"}>${c.isCurrentAuthor === false ? "（非当前作者）" : c.isCurrentAuthor === "unknown" ? "（当前作者未知）" : "（当前作者）"}`;
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
      const target = pointerTarget(event);
      if (target) completeDrag({ anchorHash: target.hash, after: target.after });
      else endDrag();
    });
    grip.addEventListener("pointercancel", (event) => { if (drag?.pointerId === event.pointerId) endDrag(); });
    grip.addEventListener("dragstart", (event) => {
      if (!canStartDrag()) { event.preventDefault(); return; }
      startDrag(undefined); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", c.hash); event.dataTransfer.setData("application/x-git-rebase-visual", JSON.stringify({ sourceHash: c.hash, revision: state.canonicalRevision }));
    });
    grip.addEventListener("dragend", () => { row.classList.remove("dragging"); endDrag(); });
    row.addEventListener("dragover", (event) => { if (!drag || isFilterActive() || state.rebaseInProgress) return; event.preventDefault(); clearDropMarkers(); const after = isAfter(event, row); row.classList.add(after ? "drop-after" : "drop-before"); setDragHint(`将 ${short(drag.sourceHash)} 移动到 ${short(c.hash)} ${after ? "之后" : "之前"}`); });
    row.addEventListener("drop", (event) => {
      if (!drag || isFilterActive() || state.rebaseInProgress || drag.sourceHash === c.hash) return;
      event.preventDefault();
      completeDrag({ anchorHash: c.hash, after: isAfter(event, row) });
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      selectContextTarget(c);
      openMenu(event.clientX, event.clientY, c, row);
    });
    row.addEventListener("click", (event) => selectRow(event, c));
    row.addEventListener("keydown", (event) => rowKeydown(event, c));
    row.addEventListener("mouseenter", () => scheduleTooltip(c, row)); row.addEventListener("mouseleave", cancelTooltip);
    return row;
  }
  function selectRow(event, c) {
    if (event.target.closest(".grip")) return;
    // A normal click establishes only the active/focused commit. It deliberately
    // leaves multi-selection empty, so ordinary right-click operations always
    // target the row under the pointer rather than a stale selection.
    if (event.ctrlKey || event.metaKey) {
      selectedHashes.has(c.hash) ? selectedHashes.delete(c.hash) : selectedHashes.add(c.hash);
      selectionAnchor = c.hash;
    } else {
      selectedHashes.clear();
      selectionAnchor = c.hash;
    }
    state.activeHash = c.hash;
    renderList();
  }
  function selectContextTarget(c) {
    // A context menu is either for the existing selection containing its target
    // or for that one target. Do this before menu construction so destructive
    // batch actions can never refer to rows unrelated to the pointer.
    if (!selectedHashes.has(c.hash)) {
      selectedHashes.clear();
      selectionAnchor = c.hash;
    }
    state.activeHash = c.hash;
    renderList();
  }
  function clearSelection(event) {
    if (event.target.closest(".commit") || event.target.closest(".list-controls")) return;
    if (selectedHashes.size) { selectedHashes.clear(); selectionAnchor = null; renderList(); }
  }
  function rowKeydown(event, c) {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); selectContextTarget(c); const r = event.currentTarget.getBoundingClientRect(); openMenu(r.left + 8, r.bottom, c, event.currentTarget, { instant: true }); return; }
    if ((event.ctrlKey || event.metaKey) && event.key === " ") { event.preventDefault(); selectRow({ ctrlKey: true, target: event.currentTarget }, c); return; }
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      if (state.rebaseInProgress || isFilterActive() || c.locked) {
        announce(state.rebaseInProgress ? "变基进行中，不能重排。" : isFilterActive() ? "过滤中无法重排，请先清空搜索。" : "已锁定的 commit 不能移动。"); return;
      }
      // Alt arrows construct a one-step intent from the key event's immutable
      // snapshot. A refresh that follows cannot change what this key meant.
      selectedHashes.clear(); selectionAnchor = c.hash; state.activeHash = c.hash;
      const session = { sourceHash: c.hash, revision: state.canonicalRevision, canonicalOrder: [...state.canonicalOrder] };
      const sourceAt = session.canonicalOrder.indexOf(c.hash); const direction = event.key === "ArrowUp" ? -1 : 1; const anchor = session.canonicalOrder[sourceAt + direction];
      if (!anchor) { announce(`已在${direction < 0 ? "最早" : "最新"}位置，不能继续移动。`); renderList(); return; }
      announce(`将 ${short(c.hash)} 移动一位；等待宿主确认。`);
      postReorderFromSession(session, anchor, direction > 0); renderList(); return;
    }
    if (state.rebaseInProgress || isFilterActive() || c.locked) return;
    if (event.key === " ") {
      event.preventDefault();
      keyboardPickup = keyboardPickup
        ? null
        : { sourceHash: c.hash, revision: state.canonicalRevision, canonicalOrder: [...state.canonicalOrder] };
      announce(keyboardPickup ? `已拾取 ${short(c.hash)}；使用箭头选择位置，Enter 放下。` : "已取消移动。");
      renderList();
      return;
    }
    if (!keyboardPickup) return;
    if (event.key === "Escape") {
      event.preventDefault();
      keyboardPickup = null;
      renderList();
      return;
    }
    if (event.key === "Enter" && keyboardPickup.sourceHash !== c.hash) {
      event.preventDefault();
      const session = keyboardPickup;
      keyboardPickup = null;
      postReorderFromSession(session, c.hash, false);
      renderList();
    }
  }
  function isAfter(event, target) { const r = target.getBoundingClientRect(); return event.clientY > r.top + r.height / 2; }
  function clearDropMarkers() { document.querySelectorAll(".commit.drop-before,.commit.drop-after,.locked-run.drop-before,.locked-run.drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after")); }
  function applyDeferredState() {
    if (!deferredState) return;
    state = deferredState;
    lastStateSignature = stateSignature(state);
    deferredState = null;
    render();
  }
  function endDrag(clear = true, applyDeferred = true) {
    document.querySelectorAll(".commit.dragging").forEach((row) => row.classList.remove("dragging"));
    drag = null;
    clearDropMarkers();
    if (clear) clearDragHint();
    if (applyDeferred) applyDeferredState();
  }
  function postReorderFromSession(session, anchorHash, after) {
    if (!session || !session.sourceHash || !Array.isArray(session.canonicalOrder)) return false;
    const order = [...session.canonicalOrder];
    const sourceAt = order.indexOf(session.sourceHash);
    const anchorAt = order.indexOf(anchorHash);
    if (sourceAt < 0 || anchorAt < 0 || session.sourceHash === anchorHash) return false;
    order.splice(sourceAt, 1);
    const destination = order.indexOf(anchorHash);
    order.splice(destination + (after ? 1 : 0), 0, session.sourceHash);
    vscode.postMessage({
      type: "reorder",
      sourceHash: session.sourceHash,
      anchorHash,
      placement: after ? "after" : "before",
      revision: session.revision,
      order,
    });
    return true;
  }
  function completeDrag(target) {
    const session = drag;
    // Build and post the intent before applying any deferred refresh. The host
    // validates this original revision/order and rejects an expired session.
    const posted = target && postReorderFromSession(session, target.anchorHash, target.after);
    const source = session?.sourceHash;
    endDrag(true, false);
    if (posted) announce(`将 ${short(source)} 移动到 ${short(target.anchorHash)} ${target.after ? "之后" : "之前"}；等待确认。`);
    applyDeferredState();
  }

  function selectedMultiple() { return selectedHashes.size >= 2; }
  function selectedHashesAreContiguous() {
    if (selectedHashes.size < 2) return true;
    const indexes = state.canonicalOrder
      .map((hash, index) => selectedHashes.has(hash) ? index : -1)
      .filter((index) => index >= 0);
    return indexes.length === selectedHashes.size &&
      indexes.at(-1) - indexes[0] + 1 === selectedHashes.size;
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
  function openMenu(x, y, c, origin, options = {}) {
    hideTooltip(); menuRestoreFocus = origin || document.activeElement; menuEl.innerHTML = "";
    const multi = selectedMultiple(); const count = selectedHashes.size;
    const header = document.createElement("div"); header.className = "menu-header"; header.textContent = multi ? `已选择 ${count} 个 commit` : `${short(c.hash)} · ${c.subject}`; menuEl.append(header, sep());
    if (multi) {
      menuEl.append(group("变基与编辑"));
      const disabledReason = `已选择 ${count} 个 commit；此操作只支持单一 commit。`;
      menuEl.append(
        menuItem({ icon: "◫", label: "打开变更…", disabled: true, disabledReason }),
        menuItem({ icon: "✎", label: "编辑 message…", disabled: true, disabledReason }),
        menuItem({ icon: "⏸", label: "停靠在此 (edit)", disabled: true, disabledReason }),
        menuItem({ icon: "⌑", label: "合并到上一个 (squash)", disabled: true, disabledReason: "已选择多个 commit；不支持批量 squash，以避免跨越隐藏提交或合并语义不明确。" }),
        menuItem({ icon: "⌑", label: "合并到上一个，丢弃 message (fixup)", disabled: true, disabledReason })
      );
      const contiguous = selectedHashesAreContiguous();
      menuEl.append(sep(), group("查看"), menuItem({ icon: "▤", label: "生成 Diff…", disabled: !contiguous, disabledReason: "仅支持连续 commit；请取消未连续选择或使用单项 Diff。", action: () => vscode.postMessage({ type: "bulkGenerateDiff", hashes: [...selectedHashes], revision: state.canonicalRevision }) }), sep(), group("保护"), menuItem({ icon: "🔒", label: "批量锁定 commit", action: () => vscode.postMessage({ type: "bulkLock", hashes: [...selectedHashes] }) }), sep(), group("危险操作"), menuItem({ icon: "⌫", label: "批量删除 commit", danger: true, action: () => vscode.postMessage({ type: "bulkDrop", hashes: [...selectedHashes] }) }));
    } else {
      menuEl.append(group("查看"));
      menuEl.append(menuItem({ icon: "⧉", label: "复制 hash", action: () => send("copyHash", c) }), menuItem({ icon: "⧉", label: "复制 message", action: () => send("copyMessage", c) }), menuItem({ icon: "◫", label: "打开变更…", action: () => send("openDiff", c) }), menuItem({ icon: "▤", label: "生成 Diff…", action: () => vscode.postMessage({ type: "generateDiff", hash: c.hash, revision: state.canonicalRevision }) }), sep(), group("变基与编辑"));
      menuEl.append(menuItem({ icon: "✎", label: "编辑 message…", shortcut: "Enter", action: () => sendCompose(c, false) }), menuItem({ icon: "✦", label: "AI 生成 message…", disabled: !state.llmConfigured || state.rebaseInProgress, disabledReason: state.rebaseInProgress ? "变基进行中；如需 AI message，请先暂存改动并使用暂存区的 ✦" : "请先配置 LLM。", action: () => sendCompose(c, true) }), menuItem({ icon: "⧉", label: "追加暂存区", disabled: c.locked || !state.hasStaged || state.rebaseInProgress, disabledReason: c.locked ? "目标已锁定。" : !state.hasStaged ? "暂存区为空。" : "变基进行中。", action: () => send("appendStaged", c) }));
      const position = state.commits.indexOf(c); const predecessor = state.commits[position - 1]; const blocked = position <= 0 || c.locked || predecessor?.locked || state.rebaseInProgress;
      const reason = position <= 0 ? "第一个 commit 不能合并到前驱。" : c.locked || predecessor?.locked ? "当前 commit 或前驱已锁定。" : state.rebaseInProgress ? "变基进行中。" : "";
      menuEl.append(menuItem({ icon: "⌑", label: "合并到上一个 (squash)", disabled: blocked, disabledReason: reason, action: () => send("squash", c) }), menuItem({ icon: "⌑", label: "合并到上一个，丢弃 message (fixup)", disabled: blocked, disabledReason: reason, action: () => send("fixup", c) }), menuItem({ icon: "⏸", label: "停靠在此 (edit)", action: () => send("rebaseTo", c) }), sep(), group("保护"), menuItem(c.locked ? { icon: "🔓", label: "解除锁定", action: () => send("unlock", c) } : { icon: "🔒", label: "锁定 commit", action: () => send("lock", c) }), sep(), group("危险操作"), menuItem({ icon: "⌫", label: "删除 commit (drop)", shortcut: "Delete", danger: true, disabled: c.locked, disabledReason: c.locked ? "目标已锁定。" : "", action: () => send("drop", c) }));
    }
    // `data-instant` has to be written while the menu is still hidden: CSS reads
    // it when the reveal below starts the entrance animation. Keyboard menus
    // skip that animation because the keypress already supplied the feedback.
    if (options.instant) menuEl.dataset.instant = "true"; else delete menuEl.dataset.instant;
    menuEl.classList.remove("hidden");
    const mw = menuEl.offsetWidth; const mh = menuEl.offsetHeight;
    const left = Math.max(4, Math.min(x, window.innerWidth - mw - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - mh - 4));
    menuEl.style.left = left + "px"; menuEl.style.top = top + "px";
    // Grow from the actual trigger point, not the menu's own centre, so the
    // scale-up visibly originates where the user clicked.
    menuEl.style.setProperty("--grv-origin", `${Math.max(0, x - left)}px ${Math.max(0, y - top)}px`);
    menuEl.onkeydown = (event) => { const buttons = menuButtons(); const index = buttons.indexOf(document.activeElement); if (event.key === "ArrowDown") { event.preventDefault(); focusMenu(index + 1); } else if (event.key === "ArrowUp") { event.preventDefault(); focusMenu(index - 1); } else if (event.key === "Home") { event.preventDefault(); focusMenu(0); } else if (event.key === "End") { event.preventDefault(); focusMenu(buttons.length - 1); } else if (event.key === "Escape") { event.preventDefault(); closeMenu(); } }; focusMenu(0);
  }
  function sendCompose(c, ai) { vscode.postMessage({ type: "openCompose", mode: "commit", hash: c.hash, ai, thenEdit: false }); }
  function send(type, c) { vscode.postMessage({ type, hash: c.hash }); }
  function closeMenu() { if (menuEl.classList.contains("hidden")) return; menuClosing = true; menuEl.classList.add("hidden"); menuEl.innerHTML = ""; const restore = menuRestoreFocus; menuRestoreFocus = null; restore?.focus?.(); menuClosing = false; }
  document.addEventListener("click", (event) => { if (!menuEl.contains(event.target)) closeMenu(); clearSelection(event); }); document.addEventListener("contextmenu", (event) => { if (!event.target.closest(".commit")) { closeMenu(); clearSelection(event); } });
  // Scroll can only close the DOM menu. It deliberately neither calls
  // postMessage nor persistUi; __grvUiTrace exposes that invariant to tests.
  document.addEventListener("scroll", () => { menuScrollCloseCount++; closeMenu(); }, true); window.addEventListener("resize", () => { closeMenu(); updateBannerFocusability(); });

  // Commit detail belongs to the sidebar: a hover opens a floating tooltip over
  // the adjacent timeline area. It is dismissed as soon as the pointer leaves
  // the row (with a short grace so moving onto the tooltip keeps it open).
  function scheduleTooltip(c, row) { if (tipTimer) clearTimeout(tipTimer); if (tipHideTimer) clearTimeout(tipHideTimer); tipHash = c.hash; tipAnchor = row; const instant = Date.now() < tipInstantUntil; tipTimer = setTimeout(() => vscode.postMessage({ type: "requestDetail", hash: c.hash }), instant ? 0 : 400); }
  function cancelTooltip() { if (tipTimer) clearTimeout(tipTimer); if (tipHideTimer) clearTimeout(tipHideTimer); tipHideTimer = setTimeout(() => { if (!tipOverTip) hideTooltip(); }, 200); }
  function hideTooltip() {
    // `hideTooltip()` has three callers: leaving a shown tooltip, the 200ms
    // grace callback after a hover that never reached 400ms, and `openMenu()`.
    // Only the first means a tooltip was actually on screen and the user is
    // likely walking down the list; arming from the other two made the first
    // hover after a menu open (or a quick pass) skip the anti-misfire delay.
    // Check the DOM state here rather than adding an `arm` flag to every call
    // site: one condition, no chance for a caller to pass the wrong mode.
    const wasVisible = !tooltipEl.classList.contains("hidden");
    tooltipEl.classList.add("hidden");
    tipHash = null;
    tipAnchor = null;
    if (wasVisible) tipInstantUntil = Date.now() + 800;
  }
  function compactStat(stat) { const match = (stat || "").match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/); return match ? `${match[1]} file${match[1] === "1" ? "" : "s"}${match[2] ? ` · +${match[2]}` : ""}${match[3] ? ` −${match[3]}` : ""}` : stat; }
  function showDetail(d) {
    if (d.hash !== tipHash || !tipAnchor) return; tooltipEl.innerHTML = "";
    const top = document.createElement("div"); top.className = "tip-top"; const meta = document.createElement("div"); meta.className = "tip-meta"; meta.textContent = `${d.author} · ${d.relDate} · ${d.absDate}`;
    const actions = document.createElement("div"); actions.className = "tip-actions"; actions.append(button("⧉", () => vscode.postMessage({ type: "copyText", text: d.message }), { title: "复制完整 message" }), button("◫", () => vscode.postMessage({ type: "openDiff", hash: d.hash }), { title: "打开变更" })); top.append(meta, actions);
    const stat = document.createElement("div"); stat.className = "tip-stat"; stat.textContent = `${short(d.hash)} · ${compactStat(d.stat)}`;
    const msg = document.createElement("pre"); msg.className = "tip-msg"; msg.textContent = d.message; tooltipEl.append(top, stat, msg);
    // As with the menu, the flag must be on the element before it is revealed.
    tooltipEl.dataset.instant = Date.now() < tipInstantUntil ? "true" : "false";
    tooltipEl.classList.remove("hidden");
    const r = tipAnchor.getBoundingClientRect(); const tw = tooltipEl.offsetWidth; const th = tooltipEl.offsetHeight;
    let topPos = r.bottom + 4; const above = topPos + th > window.innerHeight - 4;
    if (above) topPos = Math.max(4, r.top - th - 4);
    tooltipEl.style.left = Math.max(4, Math.min(r.left, window.innerWidth - tw - 4)) + "px"; tooltipEl.style.top = topPos + "px";
    // The pop-in must originate from the edge facing its row: the top edge when
    // the tooltip hangs below the row, the bottom edge when it flips above it.
    tooltipEl.style.setProperty("--grv-origin", above ? "left bottom" : "left top");
  }
  tooltipEl.addEventListener("mouseenter", () => { tipOverTip = true; }); tooltipEl.addEventListener("mouseleave", () => { tipOverTip = false; hideTooltip(); });

  function persistUi() { vscode.setState({ filterText, changesMoreOpen, expandedLockedRuns: [...expandedLockedRuns] }); }
  function restoreUi() { const saved = vscode.getState(); if (!saved) return; filterText = typeof saved.filterText === "string" ? saved.filterText : ""; changesMoreOpen = !!saved.changesMoreOpen; (saved.expandedLockedRuns || []).forEach((key) => expandedLockedRuns.add(key)); }
  // Commands must never steal IME input or normal typing in editable controls.
  document.addEventListener("compositionstart", () => { isComposingInput = true; }, true);
  document.addEventListener("compositionend", () => { isComposingInput = false; }, true);
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const editable = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
    if (isComposingInput || event.isComposing || editable) {
      if (event.key === " " || event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter" || (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown"))) event.stopPropagation();
    }
  }, true);
  window.addEventListener("message", (event) => {
    const m = event.data;
    if (m.type === "state") {
      // Any state message proves the host's first refresh finished, even when it
      // is deferred behind a drag session. recoveryNotice is not a state: it only
      // merges one field into whatever we already had.
      stateLoaded = true;
      // A refresh must not destroy a native or pointer drag session. It is
      // applied after the shared session ends, preserving its revision guard.
      if (drag) { deferredState = m; return; }
      // The 1.5s status poll usually resends the same state. Rebuilding the
      // same DOM would churn the aria-live regions for no reason; skip the
      // whole render when nothing the webview consumes has changed.
      const signature = stateSignature(m);
      if (signature !== null && signature === lastStateSignature) return;
      lastStateSignature = signature;
      state = m; render();
    } else if (m.type === "recoveryNotice") {
      // Dismissal applied without a full refresh, so a drag session in progress
      // is never disturbed by hiding the banner.
      state = { ...state, recoveryNotice: m.recoveryNotice };
      lastStateSignature = stateSignature(state);
      renderBanner();
    } else if (m.type === "detail") showDetail(m);
    else if (m.type === "inlineToast") showInlineToast(m.message, m.duration);
    else if (m.type === "closeMenu") closeMenu();
  });
  // Expose only a narrow trace hook for non-browser regression harnesses. It is
  // deliberately read-only and proves scroll closes menu without postMessage/state mutation.
  window.__grvUiTrace = () => ({
    menuScrollCloseCount,
    menuClosing,
    dragging: !!drag,
    deferredRefresh: !!deferredState,
    filterText,
    selectedHashes: [...selectedHashes],
    activeHash: state.activeHash,
  });
  restoreUi(); renderDirection(); vscode.postMessage({ type: "ready" });
})();
