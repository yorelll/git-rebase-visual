import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
  Commit,
  getCommits,
  resolveRange,
  isRebaseInProgress,
  rebaseStoppedSha,
  rebaseAtEditStop,
  rebaseTodoFiles,
  currentUserEmail,
  authorColorKey,
  rebasingBranch,
  currentBranch,
  repoRoot,
  fullMessage,
  commitDetail,
  workingStatus,
  isDirty,
  conflictedFiles,
  isAncestor,
  checkGitFeature,
} from "../git/commitLog";
import {
  executeRebase,
  continueRebase,
  abortRebase,
  resolveBase,
  RebaseItem,
  RebaseBase,
} from "../git/rebaseEngine";
import { git, runGit } from "../git/gitRunner";
import {
  getUpstream,
  lockedInPush,
  resolveRefspec,
  pushRefspec,
} from "../git/pushGuard";
import { splitTrailers, applyTrailers } from "../git/message";
import {
  stashPush,
  stashPushKeepIndex,
  stashPopBySha,
  stashApplyIndexBySha,
  stashDropBySha,
  stashPopManual,
  commitIndex,
  commitAll,
} from "../git/worktree";
import { LockStore } from "../lock/lockStore";
import {
  generateMessage,
  generateFromDiff,
  getStagedDiff,
  getWorkingDiff,
} from "../llm/messageGen";
import {
  getRangeConfig,
  getLlmConfig,
  getLlmExtras,
  getPushRefspecTemplate,
  getAutoStash,
  getCollapseLockedRuns,
  isLlmConfigured,
} from "../config";
import { SecretsAccessModule, fromSecretStorage } from "./secretsAccess";
import { currentCommitSelection, rebaseProgressState } from "./rebaseState";
import { branchContext } from "./rebasePresentation";
import { ensureEditStopTarget, writeEditStopCommit } from "./editStopCommit";
import { validateReorderRequest } from "./rebaseReorderState";
import { isDraftOnlyComposeAllowedDuringRebase } from "./composePolicy";
import { ComposePanel } from "./composePanel";
import { UndoJournal, UndoRecord, undoPreflight } from "../git/undo";

const PENDING_STASH_KEY = "gitRebaseVisual.pendingStash";
const PENDING_APPEND_KEY = "gitRebaseVisual.pendingAppend";
const LLM_APIKEY_SECRET = "gitRebaseVisual.llmApiKey";
let inlineToastSink: ((message: string, duration?: number) => void) | undefined;

interface PendingAppend {
  /** Full pre-append snapshot, including the original index and worktree. */
  changeStash: string;
  /** Recovery copy for worktree-only changes left after the amend. */
  unstagedStash?: string;
  /** Original target SHA; distinguishes an external abort from a completed replay. */
  targetHash?: string;
  /**
   * True only after the staged snapshot has been committed into the edited
   * target. Old persisted records default to false, the conservative choice.
   */
  amended?: boolean;
}

interface FromWebview {
  type: string;
  [k: string]: any;
}

export class RebaseViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "gitRebaseVisual.commits";

  private view?: vscode.WebviewView;
  private commits: Commit[] = [];
  private root?: string;
  private busy = false;
  private refreshQueued = false;
  private refreshGeneration = 0;
  /** Stable IDs distinguish Compose targets without coupling them to refreshes. */
  private readonly composeTargetRevisions = new Map<string, number>();
  private nextComposeTargetRevision = 1;
  /** Hashes that are protected in the currently rendered canonical snapshot. */
  private lockedHashes = new Set<string>();
  private refreshTimer?: NodeJS.Timeout;
  private statusPoller?: NodeJS.Timeout;
  private statusPollerStarted = false;
  /** Details retained while an edit/conflict stop awaits Continue or Abort. */
  private pendingRewrite?: {
    operation: string;
    oldTip: string | undefined;
    affectedCount: number;
    undoRecord?: UndoRecord;
  };
  private readonly output: vscode.OutputChannel;
  private readonly undo: UndoJournal;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly compose: ComposePanel;
  private generationCancel?: AbortController;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly locks: LockStore
  ) {
    this.output = vscode.window.createOutputChannel("Git Rebase Visual");
    this.undo = new UndoJournal(ctx.workspaceState, ctx.globalState);
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.command = "gitRebaseVisual.reveal";
    this.statusBar.tooltip = "显示 Git Rebase Visual";
    this.compose = new ComposePanel(ctx.extensionUri, (message) => this.onMessage(message));
    inlineToastSink = (message, duration) => this.postInlineToast(message, duration);
    ctx.subscriptions.push(this.output, this.statusBar, this.compose, new vscode.Disposable(() => {
      if (inlineToastSink) inlineToastSink = undefined;
    }));
    ctx.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("gitRebaseVisual")) this.scheduleRefresh();
      }),
      vscode.workspace.onDidChangeTextDocument(() => this.scheduleRefresh()),
      vscode.workspace.onDidCreateFiles(() => this.scheduleRefresh()),
      vscode.workspace.onDidDeleteFiles(() => this.scheduleRefresh()),
      vscode.workspace.onDidRenameFiles(() => this.scheduleRefresh()),
      vscode.workspace.onDidSaveTextDocument(() => this.scheduleRefresh()),
      new vscode.Disposable(() => {
        if (this.refreshTimer) {
          clearTimeout(this.refreshTimer);
        }
        if (this.statusPoller) {
          clearInterval(this.statusPoller);
        }
      })
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.startStatusPolling();
    const stopPolling = () => {
      if (this.statusPoller) {
        clearInterval(this.statusPoller);
        this.statusPoller = undefined;
      }
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = undefined;
      }
      this.statusPollerStarted = false;
    };
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.startStatusPolling();
        void this.refresh();
      } else {
        stopPolling();
      }
    });
    view.onDidDispose(() => {
      stopPolling();
      if (this.view === view) {
        this.view = undefined;
      }
    });
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.ctx.extensionUri, "media"),
      ],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    void this.refresh();
  }

  private cwd(): string | undefined {
    return this.root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private startStatusPolling(): void {
    if (this.statusPollerStarted) {
      return;
    }
    this.statusPollerStarted = true;
    this.statusPoller = setInterval(() => this.scheduleRefresh(), 1500);
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.busy) {
        this.refreshQueued = true;
      } else if (this.view) {
        void this.refresh();
      }
    }, 400);
  }

  private log(operation: string, message: string): void {
    const safe = message
      .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1***@")
      .replace(/(authorization:\s*bearer\s+)\S+/gi, "$1***");
    this.output.appendLine(`[${new Date().toISOString()}] ${operation}: ${safe}`);
  }

  public async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration;
    const isCurrent = () => generation === this.refreshGeneration;
    const postCurrent = (msg: any) => {
      if (isCurrent()) {
        this.post(msg);
      }
    };
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
      return postCurrent({ type: "state", error: "No workspace folder open." });
    }
    const root = await repoRoot(folder);
    if (!root) {
      return postCurrent({ type: "state", error: "Not a git repository." });
    }
    if (!isCurrent()) {
      return;
    }
    this.root = root;

    // Startup capability check: surface a clear warning banner (and continue in
    // a degraded read-only fashion) when the installed Git is too old or missing
    // features the interactive edit path relies on.
    const gitOk = await checkGitFeature(root);
    if (!isCurrent()) {
      return;
    }
    if (!gitOk.ok) {
      postCurrent({
        type: "state",
        error: gitOk.message ?? "Git 环境异常。",
        rebaseInProgress: false,
      });
      return;
    }

    const rebaseInProgress = await isRebaseInProgress(root);

    // Desync recovery: if we auto-stashed for a rebase that has since finished
    // (possibly continued/aborted outside this UI, e.g. in a terminal), restore
    // the stash now. A stash the user already popped is detected and cleared.
    if (!rebaseInProgress && this.getPendingStash(root)) {
      await this.popPendingStash(root, root);
    }
    if (!rebaseInProgress && this.getPendingAppend(root)) {
      const pending = this.getPendingAppend(root)!;
      const targetRewritten = pending.targetHash
        ? (await runGit(["merge-base", "--is-ancestor", pending.targetHash, "HEAD"], { cwd: root })).code !== 0
        : true;
      const restored = await this.restorePendingAppend(root, root, !targetRewritten);
      // A stale transaction that never amended must not become a silent loss
      // when a rebase was continued outside the webview. Keep its recovery
      // stash and surface an actionable warning instead.
      if (!restored && !targetRewritten && !pending.amended) {
        const name = await this.stashNameBySha(root, pending.changeStash);
        toast("warn", `追加事务未完成，原始改动仍保存在 ${name}（stash: ${pending.changeStash.slice(0, 7)}）。请手动 apply --index 恢复。`);
      }
      // Do not render a normal actionable state while restoration itself has a
      // conflict or an unfinished append needs manual recovery. A subsequent
      // refresh may retry safely after the user resolves it.
      if (!restored) {
        return;
      }
    }
    if (!isCurrent()) {
      return;
    }

    // During a rebase HEAD is detached; resolve the range against the branch
    // being rebased so we still show meaningful commits instead of "no upstream".
    const rangeConfig = getRangeConfig();
    const tipRef = rebaseInProgress ? await rebasingBranch(root) : undefined;
    const branch = tipRef ?? await currentBranch(root);
    const upstream = branch ? await getUpstream(root, branch) : undefined;
    let aheadCount = 0;
    let behindCount = 0;
    if (upstream) {
      const counts = await runGit(["rev-list", "--left-right", "--count", `${upstream.ref}...HEAD`], { cwd: root });
      const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
      if (counts.code === 0 && Number.isFinite(ahead) && Number.isFinite(behind)) {
        aheadCount = ahead;
        behindCount = behind;
      }
    }
    const presentation = branchContext({
      branchName: branch,
      upstreamRef: upstream?.ref,
      aheadCount,
      behindCount,
      range: rangeConfig,
      rebasing: rebaseInProgress,
    });
    const range = await resolveRange(root, rangeConfig, tipRef ?? "HEAD");
    if ("error" in range) {
      return postCurrent({ type: "state", error: range.error, rebaseInProgress, ...presentation, collapseLockedRuns: getCollapseLockedRuns() });
    }

    let commits: Commit[];
    try {
      commits = await getCommits(root, range.revRange);
    } catch (e: any) {
      return postCurrent({ type: "state", error: String(e.message ?? e), rebaseInProgress });
    }

    const [stoppedAt, atEditStop, conflictPaths, todoFiles, userEmail] = rebaseInProgress
      ? await Promise.all([
          rebaseStoppedSha(root),
          rebaseAtEditStop(root),
          conflictedFiles(root),
          rebaseTodoFiles(root),
          currentUserEmail(root),
        ])
      : [undefined, false, [] as string[], {}, await currentUserEmail(root)];
    const progress = rebaseProgressState({
      rebaseInProgress,
      atEditStop,
      conflictFiles: conflictPaths,
      doneLines: todoFiles.doneLines,
      todoLines: todoFiles.todoLines,
      stoppedHash: stoppedAt,
    });
    if (rebaseInProgress) {
      const position = progress.totalSteps !== undefined && progress.completedSteps !== undefined
        ? `${Math.min(progress.completedSteps + 1, progress.totalSteps)}/${progress.totalSteps}`
        : "unknown";
      this.statusBar.text = `$(git-branch) rebase ${position} · ${progress.pausedReason ?? "进行中"}`;
      this.statusBar.show();
    } else {
      this.statusBar.hide();
    }

    // Determine locked state per commit. Only compute patch-ids when locks
    // exist (patch-id computation costs two git calls per commit).
    const hasLocks = this.locks.hasLocks(root);
    const lockedHashes = this.locks.lockedHashes(root);
    const lockedPatchIds = this.locks.lockedPatchIds(root);
    const lockedFlags = new Map<string, boolean>();
    for (const c of commits) {
      let isLocked = lockedHashes.has(c.hash);
      if (!isLocked && hasLocks && lockedPatchIds.size > 0) {
        const pid = await this.locks.computePatchId(root, c.hash);
        isLocked = !!pid && lockedPatchIds.has(pid);
      }
      lockedFlags.set(c.hash, isLocked);
    }

    const status = await workingStatus(root);
    if (!isCurrent()) {
      return;
    }
    this.commits = commits;
    this.lockedHashes = new Set(
      commits.filter((commit) => lockedFlags.get(commit.hash)).map((commit) => commit.hash)
    );

    // Send oldest-first (root at top, newest at bottom) for a natural timeline.
    const ordered = [...commits].reverse();
    postCurrent({
      type: "state",
      rebaseInProgress,
      stoppedAt,
      ...progress,
      llmConfigured: isLlmConfigured(),
      undoHistory: this.undo.records().filter((record) => record.repository === root),
      undoAvailable: !!this.undo.latestCompleted(root),
      currentUserEmail: userEmail,
      currentAuthorKnown: !!userEmail,
      ...presentation,
      collapseLockedRuns: getCollapseLockedRuns(),
      hasStaged: status.hasStaged,
      hasUnstaged: status.hasUnstaged,
      stagedCount: status.stagedCount,
      unstagedCount: status.unstagedCount,
      canonicalRevision: generation,
      canonicalOrder: ordered.map((commit) => commit.hash),
      commits: ordered.map((c) => ({
        hash: c.hash,
        shortHash: c.shortHash,
        subject: c.subject,
        author: c.author,
        authorEmail: c.authorEmail,
        authorInitial: (c.author || c.authorEmail || "?").trim().charAt(0).toUpperCase() || "?",
        authorColorKey: authorColorKey(c.authorEmail || c.author),
        isCurrentAuthor: userEmail ? c.authorEmail.toLowerCase() === userEmail.toLowerCase() : "unknown",
        date: c.date,
        locked: lockedFlags.get(c.hash) ?? false,
      })),
    });
  }

  private post(msg: any): void {
    this.view?.webview.postMessage(msg);
  }

  private postInlineToast(message: string, duration = 2500): void {
    this.post({ type: "inlineToast", level: "success", message, duration });
  }

  private isCurrentCommitHash(value: unknown): value is string {
    return (
      typeof value === "string" &&
      /^[0-9a-f]{40}$/i.test(value) &&
      this.commits.some((commit) => commit.hash === value)
    );
  }

  /** Builds todo items (oldest-first) from current commits, applying an action. */
  private itemsWith(
    override?: (hash: string) => RebaseItem["action"] | undefined
  ): RebaseItem[] {
    // this.commits is newest-first; todo order is oldest-first.
    return [...this.commits]
      .reverse()
      .map((c) => ({
        hash: c.hash,
        action: (override?.(c.hash) ?? "pick") as RebaseItem["action"],
        subject: c.subject,
      }));
  }

  private async onMessage(m: FromWebview): Promise<void> {
    const mutating = [
      "reorder",
      "drop",
      "bulkDrop",
      "bulkLock",
      "rebaseTo",
      "lock",
      "unlock",
      "openCompose",
      "generate",
      "apply",
      "appendStaged",
      "continueRebase",
      "abortRebase",
      "skipRebase",
      "undo",
      "showUndoHistory",
      "squash",
      "fixup",
      "commitEditAmend",
      "commitEditNew",
      "bulkSquash",
    ];
    if (mutating.includes(m.type)) {
      if (this.busy) {
        toast("warn", "上一个操作尚未完成，请稍候。");
        return;
      }
      this.busy = true;
      try {
        await this.handleMessage(m);
      } finally {
        this.busy = false;
        if (this.refreshQueued) {
          this.refreshQueued = false;
          void this.refresh();
        }
      }
      return;
    }
    await this.handleMessage(m);
  }

  private async handleMessage(m: FromWebview): Promise<void> {
    const cwd = this.cwd();
    const hashActions = new Set([
      "copyHash",
      "copyMessage",
      "openDiff",
      "requestDetail",
      "drop",
      "rebaseTo",
      "lock",
      "unlock",
      "appendStaged",
    ]);
    // At an edit stop, the exact stopped SHA is valid target context even when
    // the branch-range projection is temporarily unavailable/detached.
    const editStopCompose =
      m.type === "openCompose" && m.mode === "commit" && m.thenEdit === true && typeof m.hash === "string";
    const requiresCurrentCommit =
      hashActions.has(m.type) ||
      ((m.type === "openCompose" || m.type === "apply") && m.mode === "commit" && !editStopCompose);
    if (requiresCurrentCommit && !this.isCurrentCommitHash(m.hash)) {
      const message = "commit 列表已更新，请刷新后重试。";
      if (m.type === "apply") {
        this.compose.post({ type: "applyFailed", message });
        this.compose.post({ type: "staleTarget", message: "目标 commit 已变化；草稿仍保留，建议确认后重新打开。" });
      }
      toast("warn", message);
      await this.refresh();
      return;
    }
    if (!cwd && m.type !== "ready") {
      return;
    }
    // A paused rebase has a deliberately narrow mutation allow-list. Compose
    // reword/apply would otherwise start or modify an unrelated external rebase.
    // An edit stop may amend/create only after ensureEditStop verifies it below;
    // a conflict never gets those paths.
    if (cwd && (await isRebaseInProgress(cwd))) {
      const allowed = new Set(["continueRebase", "abortRebase", "skipRebase", "commitEditAmend", "commitEditNew"]);
      const draftOnlyCompose =
        m.type === "openCompose" &&
        isDraftOnlyComposeAllowedDuringRebase(m.mode, m.messageOnly === true);
      const editStopCompose =
        m.type === "openCompose" && m.mode === "commit" && m.thenEdit === true && typeof m.hash === "string";
      const editStopNewCompose =
        m.type === "openCompose" && m.mode === "staged" && m.editKind === "new" && m.ai !== true;
      if (!allowed.has(m.type) && m.type !== "copyText" && !draftOnlyCompose && !editStopCompose && !editStopNewCompose) {
        const message = "变基进行中：此操作不能在当前暂停状态执行。";
        if (m.type === "apply") this.compose.post({ type: "applyFailed", message });
        vscode.window.showWarningMessage(message);
        return;
      }
    }
    try {
      switch (m.type) {
        case "ready":
        case "refresh":
          await this.refresh();
          break;
        case "copyHash":
          await vscode.env.clipboard.writeText(m.hash);
          toast("info", `已复制 ${m.hash}`);
          break;
        case "copyMessage":
          await vscode.env.clipboard.writeText(await fullMessage(cwd!, m.hash));
          toast("info", "已复制完整 message。");
          break;
        case "openDiff":
          await this.openDiffDocument(cwd!, m.hash);
          break;
        case "copyText":
          await vscode.env.clipboard.writeText(m.text ?? "");
          toast("info", "已复制到剪贴板");
          break;
        case "openLlmSettings":
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "gitRebaseVisual.llm"
          );
          break;
        case "requestDetail":
          await this.sendDetail(cwd!, m.hash);
          break;
        case "reorder":
          await this.handleReorder(cwd!, m);
          break;
        case "drop": {
          await this.dropCommits(cwd!, [m.hash]);
          await this.refresh();
          break;
        }
        case "bulkDrop": {
          const hashes = this.selectedHashes(m.hashes);
          if (!hashes) {
            toast("warn", "批量选择已过期；请刷新后重试。 ");
            await this.refresh();
            return;
          }
          await this.dropCommits(cwd!, hashes);
          await this.refresh();
          break;
        }
        case "bulkLock": {
          const hashes = this.selectedHashes(m.hashes);
          if (!hashes) {
            toast("warn", "批量选择已过期；请刷新后重试。 ");
            await this.refresh();
            return;
          }
          await this.lockCommits(cwd!, hashes);
          await this.refresh();
          break;
        }
        case "bulkSquash": {
          await this.squashSelection(cwd!, m.hashes);
          await this.refresh();
          break;
        }
        case "squash":
        case "fixup": {
          await this.combineWithPrevious(cwd!, m.hash, m.type);
          await this.refresh();
          break;
        }
        case "rebaseTo": {
          const commit = this.commits.find((c) => c.hash === m.hash)!;
          const confirm = await vscode.window.showWarningMessage(
            `将在 ${commit.shortHash} “${commit.subject}” 停靠 (edit)。这会开始变基并改写后续提交。`,
            { modal: true },
            "开始变基"
          );
          if (confirm !== "开始变基") {
            return;
          }
          await this.runRebase(cwd!, {
            items: this.itemsWith((h) => (h === m.hash ? "edit" : undefined)),
            operation: "停靠在此 (edit)",
            affectedCount: this.commits.length,
          });
          await this.refresh();
          break;
        }
        case "lock": {
          const pid = await this.locks.computePatchId(cwd!, m.hash);
          await this.locks.lock(this.root!, m.hash, pid);
          await this.refresh();
          break;
        }
        case "unlock": {
          const pid = await this.locks.computePatchId(cwd!, m.hash);
          await this.locks.unlock(this.root!, m.hash, pid);
          await this.refresh();
          break;
        }
        case "closeCompose":
          // The page sends this only after its dirty-draft discard confirmation.
          // Never let a stale retained document close a newer Compose target.
          if (!this.compose.discardActiveDraft(m.sessionId, m.revision)) {
            return;
          }
          this.compose.close();
          break;
        case "cancelGeneration":
          this.generationCancel?.abort();
          break;
        case "openCompose":
          await this.openCompose(cwd!, m.mode, m.hash, m.thenEdit === true, m.ai === true, m.messageOnly === true, m.editKind);
          break;
        case "appendStaged":
          await this.appendStagedToCommit(cwd!, m.hash);
          break;
        case "generate":
          await this.generate(cwd!, m.mode, m.hash, m.extra ?? "");
          break;
        case "apply":
          // A retained/reloaded webview can otherwise apply an old draft to a
          // newer target. Git target checks below are necessary but not enough
          // for staged/working Compose, which has no commit hash.
          if (!this.compose.acceptsActiveSession(m.sessionId, m.revision)) {
            this.compose.post({ type: "applyFailed", message: "Compose 会话已过期；草稿未应用，请重新打开目标。" });
            this.compose.post({ type: "staleTarget", message: "目标或编辑会话已变化；未执行 Git 写入。" });
            return;
          }
          await this.apply(cwd!, m.mode, m.hash, m.message, m.thenEdit === true, m.sessionId, m.revision);
          break;
        case "commitEditAmend":
        case "commitEditNew": {
          if (!this.compose.acceptsActiveSession(m.sessionId, m.revision)) {
            this.compose.post({ type: "applyFailed", message: "Compose 会话已过期；草稿未应用，请重新打开目标。" });
            this.compose.post({ type: "staleTarget", message: "目标或编辑会话已变化；未执行 Git 写入。" });
            return;
          }
          await this.commitAtEditStop(
            cwd!,
            m.type === "commitEditAmend" ? "amend" : "new",
            m.message,
            m.sessionId,
            m.revision
          );
          break;
        }
        case "skipRebase": {
          await this.skipConflictRebase(cwd!);
          await this.refresh();
          break;
        }
        case "undo": {
          await this.undoLatest(cwd!, m.id);
          await this.refresh();
          break;
        }
        case "showUndoHistory":
          await this.showUndoHistory();
          break;
        case "continueRebase": {
          const conflicts = await conflictedFiles(cwd!);
          if (conflicts.length > 0) {
            toast(
              "warn",
              `仍有 ${conflicts.length} 个冲突文件未解决：${conflicts.join("、")}。解决并暂存后再 Continue。`
            );
            await this.refresh();
            return;
          }
          const pendingAppend = this.getPendingAppend(this.root!);
          if (pendingAppend && !pendingAppend.amended) {
            const name = await this.stashNameBySha(cwd!, pendingAppend.changeStash);
            toast("warn", `追加尚未到达 amend 步骤，原始改动仍保存在 ${name}（stash: ${pendingAppend.changeStash.slice(0, 7)}）。请 Abort 以自动恢复，不能 Continue。`);
            return;
          }
          const r = await continueRebase(cwd!);
          if (!r.ok) {
            toast("error", r.message || "Continue 失败，请检查 Output。");
          }
          // Restore the auto-stash once the rebase is fully done.
          if (!(await isRebaseInProgress(cwd!))) {
            await this.popPendingStash(cwd!, this.root!);
            const appendRestored = await this.restorePendingAppend(cwd!, this.root!);
            if (!appendRestored) {
              await this.refresh();
              return;
            }
            if (r.ok && this.pendingRewrite) {
              const pending = this.pendingRewrite;
              this.pendingRewrite = undefined;
              const newTip = await this.headTip(cwd!);
              if (pending.oldTip !== newTip) {
                await this.reportRewrite(
                  cwd!,
                  pending.operation,
                  pending.oldTip,
                  pending.affectedCount,
                  pending.undoRecord
                );
              } else {
                if (pending.undoRecord) await this.undo.mark(pending.undoRecord, "aborted");
              this.log("rebase", `${pending.operation} 未改变 HEAD；未报告历史改写。`);
              }
            }
          }
          await this.refresh();
          break;
        }
        case "abortRebase": {
          const confirm = await vscode.window.showWarningMessage(
            "Abort 将丢弃本次变基的所有中间结果，并恢复变基开始前的历史。",
            { modal: true },
            "Abort"
          );
          if (confirm !== "Abort") {
            return;
          }
          await abortRebase(cwd!);
          if (this.pendingRewrite?.undoRecord) await this.undo.mark(this.pendingRewrite.undoRecord, "aborted");
          this.pendingRewrite = undefined;
          await this.popPendingStash(cwd!, this.root!);
          await this.restorePendingAppend(cwd!, this.root!, true);
          toast("info", "已 Abort 变基并请求恢复变基前历史。", 5000);
          await this.refresh();
          break;
        }
      }
    } catch (e: any) {
      const message = String(e.message ?? e);
      this.log(m.type, `失败 ${message}`);
      if (m.type === "apply") {
        this.compose.post({ type: "applyFailed", message });
      }
      toast("error", message);
      await this.refresh();
    }
  }

  /** Revalidates a webview multi-selection against the current full snapshot. */
  private selectedHashes(value: unknown): string[] | undefined {
    return currentCommitSelection(value, this.commits.map((commit) => commit.hash));
  }

  /** Locks all requested current commits after resolving each patch identity. */
  private async lockCommits(cwd: string, hashes: string[]): Promise<void> {
    const selected = this.selectedHashes(hashes);
    if (!selected) throw new Error("批量锁定选择已失效；未修改任何锁定状态。 ");
    const entries = await Promise.all(selected.map(async (hash) => ({
      hash, patchId: await this.locks.computePatchId(cwd, hash),
    })));
    // Revalidate after all asynchronous patch-id lookups and before the single
    // persistence write, so a refreshed snapshot cannot receive partial locks.
    if (!this.selectedHashes(selected)) {
      throw new Error("批量锁定期间 commit 列表已变化；未修改任何锁定状态。 ");
    }
    await this.locks.lockMany(this.root!, entries);
    toast("info", `已锁定 ${selected.length} 个 commit。`);
  }

  /**
   * Builds exactly one rebase plan for a selection. Revalidation and all lock
   * checks happen before confirmation and before any write, so a stale bulk
   * request cannot partially drop a changed list.
   */
  private async dropCommits(cwd: string, hashes: string[]): Promise<void> {
    const selected = this.selectedHashes(hashes);
    if (!selected) throw new Error("删除选择已失效；未删除任何 commit。 ");
    const selectedSet = new Set(selected);
    const commits = this.commits.filter((commit) => selectedSet.has(commit.hash));
    for (const commit of commits) {
      const patch = await this.locks.computePatchId(cwd, commit.hash);
      if (this.locks.isLocked(this.root!, commit.hash, patch)) {
        throw new Error(`目标 ${commit.shortHash} 已锁定；未删除任何 commit。`);
      }
    }
    const preview = commits.map((commit) => `${commit.shortHash} “${commit.subject}”`).join("\n");
    const confirm = await vscode.window.showWarningMessage(
      `删除以下 ${commits.length} 个 commit？此操作会在一个 rebase 计划中改写后续历史：\n${preview}`,
      { modal: true },
      "删除所选 commit"
    );
    if (confirm !== "删除所选 commit") return;
    // Re-check immediately after the modal: user events may have refreshed the
    // view while it was open. No partial plan is ever sent to Git.
    const revalidated = this.selectedHashes(selected);
    if (!revalidated || revalidated.length !== selected.length) {
      throw new Error("删除确认期间 commit 列表已变化；未删除任何 commit。 ");
    }
    await this.runRebase(cwd, {
      items: this.itemsWith((hash) => (selectedSet.has(hash) ? "drop" : undefined)),
      operation: commits.length === 1 ? "删除 commit (drop)" : `批量删除 ${commits.length} 个 commit`,
      affectedCount: commits.length,
    });
  }

  /** Safely squash an exact contiguous selection into its first commit. */
  private async squashSelection(cwd: string, value: unknown): Promise<void> {
    const selected = this.selectedHashes(value);
    if (!selected || selected.length < 2) {
      toast("warn", "请选择至少两个当前 commit 以批量 squash。 ");
      return;
    }
    const ordered = [...this.commits].reverse();
    const indexes = selected.map((hash) => ordered.findIndex((commit) => commit.hash === hash)).sort((a, b) => a - b);
    if (indexes.some((index) => index < 0) || indexes.some((index, i) => i > 0 && index !== indexes[i - 1] + 1)) {
      toast("warn", "批量 squash 只接受连续的完整选择；不会猜测跨越隐藏 commit 的顺序。 ");
      return;
    }
    if (indexes[0] === 0 || indexes.some((index) => this.lockedHashes.has(ordered[index].hash))) {
      toast("warn", "首个 commit 或任何已锁定 commit 不能参与批量 squash。 ");
      return;
    }
    const selectedSet = new Set(selected);
    const names = indexes.map((index) => ordered[index].shortHash).join("、");
    const confirmation = await vscode.window.showWarningMessage(
      `将连续的 ${selected.length} 个 commit（${names}）合并为一个 commit，并改写后续历史。继续吗？`,
      { modal: true },
      "批量 Squash"
    );
    if (confirmation !== "批量 Squash") return;
    const rechecked = this.selectedHashes(selected);
    if (!rechecked || rechecked.length !== selected.length) {
      throw new Error("确认期间选择已变化；未执行批量 squash。 ");
    }
    await this.runRebase(cwd, {
      items: this.itemsWith((hash) => selectedSet.has(hash) && hash !== ordered[indexes[0]].hash ? "squash" : undefined),
      operation: `批量 squash ${selected.length} 个 commit`,
      affectedCount: ordered.length - indexes[0],
    });
  }

  private async combineWithPrevious(cwd: string, hash: string, action: "squash" | "fixup"): Promise<void> {
    const ordered = [...this.commits].reverse();
    const index = ordered.findIndex((commit) => commit.hash === hash);
    if (index <= 0) {
      toast("warn", "第一个 commit 不能 squash 或 fixup。 ");
      return;
    }
    const target = ordered[index];
    const predecessor = ordered[index - 1];
    for (const commit of [target, predecessor]) {
      const patch = await this.locks.computePatchId(cwd, commit.hash);
      if (this.locks.isLocked(this.root!, commit.hash, patch)) {
        toast("warn", "目标 commit 或其前驱已锁定，不能 squash/fixup。 ");
        return;
      }
    }
    const label = action === "squash" ? "合并到上一个 (squash)" : "合并到上一个，丢弃 message (fixup)";
    const confirmed = await vscode.window.showWarningMessage(
      `${label}：${target.shortHash} “${target.subject}”？这会改写后续历史。`,
      { modal: true },
      action === "squash" ? "Squash" : "Fixup"
    );
    if (confirmed !== (action === "squash" ? "Squash" : "Fixup")) return;
    await this.runRebase(cwd, {
      items: this.itemsWith((itemHash) => itemHash === hash ? action : undefined),
      operation: label,
      affectedCount: ordered.length - index + 1,
    });
  }

  private async ensureEditStop(cwd: string): Promise<void> {
    await ensureEditStopTarget(cwd);
  }

  private async commitAtEditStop(
    cwd: string,
    kind: "amend" | "new",
    message: unknown,
    sessionId?: unknown,
    revision?: unknown
  ): Promise<void> {
    if (typeof message !== "string" || !message.trim()) {
      this.compose.post({ type: "applyFailed", message: "Commit message 不能为空。" });
      return;
    }
    // Resolve the target once before the active-session comparison, then the
    // helper repeats the Git-state/staged guard immediately before its write.
    const stopped = await ensureEditStopTarget(cwd);
    const active = this.compose.activeSession();
    if (kind === "amend" && active?.hash !== stopped) {
      this.compose.post({ type: "applyFailed", message: "目标 edit commit 已变化；未执行 amend。" });
      this.compose.post({ type: "staleTarget", message: "当前停靠目标已变化；草稿仍保留。" });
      return;
    }
    if (kind === "new" && (active?.mode !== "staged" || active.editKind !== "new")) {
      this.compose.post({ type: "applyFailed", message: "新建 commit 的 Compose 上下文已过期；未执行 Git 写入。" });
      return;
    }
    await writeEditStopCommit(cwd, kind, message);
    this.compose.clearDraft(sessionId, revision);
    this.compose.post({ type: "applySucceeded" });
    this.post({ type: "applySucceeded" });
    toast("info", kind === "amend" ? "已 amend 当前 edit commit。" : "已在 edit 停靠创建新 commit。 ");
  }

  private async skipConflictRebase(cwd: string): Promise<void> {
    const [conflicts, stopped] = await Promise.all([conflictedFiles(cwd), rebaseStoppedSha(cwd)]);
    if (conflicts.length === 0) {
      toast("warn", "Skip 仅在存在冲突的暂停状态可用。 ");
      return;
    }
    const commit = stopped ? this.commits.find((item) => item.hash === stopped) : undefined;
    const confirmed = await vscode.window.showWarningMessage(
      `Skip 将丢弃 source commit ${commit?.shortHash ?? stopped?.slice(0, 10) ?? "unknown"} “${commit?.subject ?? "unknown"}” 的 patch；该改动不会被重放。继续？`,
      { modal: true },
      "丢弃 patch 并 Skip"
    );
    if (confirmed !== "丢弃 patch 并 Skip") return;
    const result = await runGit(["rebase", "--skip"], { cwd });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Skip 失败。");
    toast("info", "已 Skip 冲突 commit；其 patch 已丢弃。 ");
  }

  private async undoLatest(cwd: string, requestedId?: unknown): Promise<void> {
    const recordRoot = await repoRoot(cwd);
    if (!recordRoot) {
      toast("warn", "当前目录不是 Git 仓库，不能撤销。 ");
      return;
    }
    const record = typeof requestedId === "string"
      ? this.undo.records().find(
          (item) => item.id === requestedId && item.status === "completed" && item.repository === recordRoot
        )
      : this.undo.latestCompleted(recordRoot);
    if (!record) {
      toast("warn", "没有可安全撤销的操作。 ");
      return;
    }
    const [inProgress, branch, head, dirty, ref, root] = await Promise.all([
      isRebaseInProgress(cwd), currentBranch(cwd), this.headTip(cwd), isDirty(cwd),
      runGit(["show-ref", "--verify", "--quiet", record.beforeRef], { cwd }), repoRoot(cwd),
    ]);
    if (!root || root !== record.repository) {
      toast("warn", "Undo 记录属于另一个仓库，不能在当前仓库撤销。 ");
      return;
    }
    const safe = undoPreflight({
      rebaseInProgress: inProgress, currentBranch: branch, expectedBranch: record.branch,
      head, expectedAfterTip: record.afterTip, dirty, refExists: ref.code === 0,
    });
    if (!safe.ok) {
      toast("warn", safe.reason!);
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `撤销“${record.operation}”：${record.afterTip?.slice(0, 10)} → ${record.beforeTip.slice(0, 10)}。这会改写本地历史；若已推送，必须由你自行确认并使用 force-with-lease，插件不会自动推送。`,
      { modal: true }, "撤销"
    );
    if (confirm !== "撤销") return;
    // --keep rejects instead of silently losing a dirty merge/worktree state.
    const reset = await runGit(["reset", "--keep", record.beforeRef], { cwd });
    if (reset.code !== 0) throw new Error(reset.stderr || reset.stdout || "撤销失败；工作区未被丢弃。 ");
    await this.undo.mark(record, "undone");
    toast("info", `已撤销 ${record.operation}；未自动 force push。`);
  }

  private async showUndoHistory(): Promise<void> {
    const cwd = this.cwd();
    const root = cwd ? await repoRoot(cwd) : undefined;
    if (!root) {
      toast("warn", "当前目录不是 Git 仓库，无法显示 Undo 历史。 ");
      return;
    }
    const items = this.undo.records().filter((record) => record.repository === root).map((record) => ({
      label: `${record.status === "completed" ? "↺" : "—"} ${record.operation} · ${record.status}`,
      description: `${record.beforeTip.slice(0, 10)} → ${record.afterTip?.slice(0, 10) ?? "pending"}`,
      detail: `${record.createdAt} · ${record.affectedSteps} steps`,
      record,
    }));
    const choice = await vscode.window.showQuickPick(items, { placeHolder: "最近操作历史；仅 completed 项可撤销" });
    if (choice?.record.status === "completed") {
      await this.undoLatest(cwd!, choice.record.id);
    }
  }

  private async handleReorder(cwd: string, request: FromWebview): Promise<void> {
    // A webview may be stale, filtered, or tampered with. Derive the only valid
    // result from source/anchor/placement and require its full canonical order.
    const canonicalOrder = [...this.commits].reverse().map((commit) => commit.hash);
    const checked = validateReorderRequest(
      request,
      canonicalOrder,
      this.refreshGeneration,
      this.lockedHashes
    );
    if (!checked.ok) {
      toast("warn", checked.reason);
      await this.refresh();
      return;
    }
    const { sourceHash, anchorHash, placement, affectedCount } = checked.value;
    const byHash = new Map(this.commits.map((commit) => [commit.hash, commit]));
    const source = byHash.get(sourceHash)!;
    const anchor = byHash.get(anchorHash)!;
    const confirm = await vscode.window.showWarningMessage(
      `将 ${source.shortHash} “${source.subject}” 移动到 ${anchor.shortHash} “${anchor.subject}”${placement === "after" ? "之后" : "之前"}；将改写至少 ${affectedCount} 个 commit 的 hash。继续吗？`,
      { modal: true },
      "重排"
    );
    if (confirm !== "重排") {
      await this.refresh();
      return;
    }
    // Revalidate after the confirmation. The view can refresh while its modal is open.
    const finalCheck = validateReorderRequest(
      request,
      [...this.commits].reverse().map((commit) => commit.hash),
      this.refreshGeneration,
      this.lockedHashes
    );
    if (!finalCheck.ok) {
      toast("warn", `${finalCheck.reason} 未执行 Git 写入。`);
      await this.refresh();
      return;
    }
    const finalByHash = new Map(this.commits.map((commit) => [commit.hash, commit]));
    const items: RebaseItem[] = finalCheck.value.order.map((hash) => ({
      hash,
      action: "pick",
      subject: finalByHash.get(hash)!.subject,
    }));
    await this.runRebase(cwd, {
      items,
      operation: "拖拽重排",
      affectedCount: finalCheck.value.affectedCount,
    });
    await this.refresh();
  }

  /** Base = parent of the range's ORIGINAL oldest commit (independent of reordering). */
  private async computeBase(cwd: string): Promise<RebaseBase | undefined> {
    if (this.commits.length === 0) {
      return undefined;
    }
    const oldest = this.commits[this.commits.length - 1].hash;
    return resolveBase(cwd, oldest);
  }

  // ---- pending-stash tracking (per repo, survives reloads) ---------------

  private getPendingStash(root: string): string | undefined {
    const map = this.ctx.workspaceState.get<Record<string, string>>(
      PENDING_STASH_KEY,
      {}
    );
    return map[root];
  }

  private async setPendingStash(root: string, sha: string): Promise<void> {
    const map = this.ctx.workspaceState.get<Record<string, string>>(
      PENDING_STASH_KEY,
      {}
    );
    map[root] = sha;
    await this.ctx.workspaceState.update(PENDING_STASH_KEY, map);
  }

  private async clearPendingStash(root: string): Promise<void> {
    const map = this.ctx.workspaceState.get<Record<string, string>>(
      PENDING_STASH_KEY,
      {}
    );
    if (map[root]) {
      delete map[root];
      await this.ctx.workspaceState.update(PENDING_STASH_KEY, map);
    }
  }

  private getPendingAppend(root: string): PendingAppend | undefined {
    return this.ctx.workspaceState.get<Record<string, PendingAppend>>(
      PENDING_APPEND_KEY,
      {}
    )[root];
  }

  private async setPendingAppend(root: string, pending: PendingAppend): Promise<void> {
    const map = this.ctx.workspaceState.get<Record<string, PendingAppend>>(
      PENDING_APPEND_KEY,
      {}
    );
    map[root] = pending;
    await this.ctx.workspaceState.update(PENDING_APPEND_KEY, map);
  }

  private async clearPendingAppend(root: string): Promise<void> {
    const map = this.ctx.workspaceState.get<Record<string, PendingAppend>>(
      PENDING_APPEND_KEY,
      {}
    );
    if (map[root]) {
      delete map[root];
      await this.ctx.workspaceState.update(PENDING_APPEND_KEY, map);
    }
  }

  /**
   * Restores a previously auto-stashed change set (identified by sha), called
   * after a rebase fully finishes or the user Continues/Aborts. Robust to the
   * user having already popped it manually elsewhere (gone => clear silently).
   */
  private async popPendingStash(cwd: string, root: string): Promise<void> {
    const sha = this.getPendingStash(root);
    if (!sha) {
      return;
    }
    const res = await stashPopBySha(cwd, sha);
    await this.clearPendingStash(root);
    if (res.gone) {
      return; // user already restored it — nothing to do
    }
    if (!res.ok) {
      // Show the exact stash name (stash@{n}) so the "manual restore" hint is
      // actionable: identify it from the stable sha.
      const name = await this.stashNameBySha(cwd, sha);
      toast(
        "warn",
        `恢复自动 stash 时有冲突：${res.message}。安全副本 ${name}（stash: ${sha.slice(0, 7)}）仍保留，请使用 “git stash list” / “git stash pop ${name}” 手动恢复。`
      );
    } else {
      toast("info", "已恢复自动 stash 的改动（已弹出 stash@{0}/原 stash）。");
    }
  }

  /** Resolves the human-readable stash name (stash@{n}) for a stash commit sha. */
  private async stashNameBySha(cwd: string, sha: string): Promise<string> {
    const list = await runGit(["stash", "list", "--format=%H"], { cwd });
    if (list.code !== 0) {
      return "对应 stash";
    }
    const idx = list.stdout.split("\n").map((l) => l.trim()).filter(Boolean).indexOf(sha);
    return idx >= 0 ? `stash@{${idx}}` : "对应 stash";
  }

  /** Restores stashes recorded while appending staged changes to a commit. */
  private async restorePendingAppend(
    cwd: string,
    root: string,
    restoreOriginalIndex = false
  ): Promise<boolean> {
    const pending = this.getPendingAppend(root);
    if (!pending) {
      return true;
    }
    if (restoreOriginalIndex) {
      const restore = await stashApplyIndexBySha(cwd, pending.changeStash);
      if (restore.gone) {
        // A user may have restored/dropped the recovery stash manually. It is
        // safe to clear the transaction only if there is no additional
        // worktree-only stash still to restore.
        if (!pending.unstagedStash) {
          await this.clearPendingAppend(root);
          return true;
        }
        return false;
      }
      if (!restore.ok) {
        const name = await this.stashNameBySha(cwd, pending.changeStash);
        toast("warn", `恢复原始暂存区时有冲突：${restore.message}。安全副本 ${name}（stash: ${pending.changeStash.slice(0, 7)}）仍保留，请用 “git stash list” / “git stash apply --index ${name}” 手动恢复。`);
        return false;
      }
      // The full snapshot already includes the worktree-only changes. Popping
      // the later keep-index snapshot here would apply those same changes a
      // second time and can manufacture a conflict during Abort.
      if (pending.unstagedStash) {
        await stashDropBySha(cwd, pending.unstagedStash);
      }
      await stashDropBySha(cwd, pending.changeStash);
      await this.clearPendingAppend(root);
      return true;
    }
    if (!pending.amended) {
      if (!restoreOriginalIndex) {
        // A paused append failed before --amend. Continue must not silently
        // discard the original staged snapshot; tell the user to Abort or
        // restore it manually before proceeding.
        const name = await this.stashNameBySha(cwd, pending.changeStash);
        toast("warn", `追加尚未完成，原始改动仍保存在 ${name}（stash: ${pending.changeStash.slice(0, 7)}）。请 Abort 以自动恢复，或手动 apply --index 后再 Continue。`);
        return false;
      }
      // Abort applied the original index successfully; now remove the recovery
      // copy and complete the transaction.
      await stashDropBySha(cwd, pending.changeStash);
      await this.clearPendingAppend(root);
      return true;
    }
    if (pending.unstagedStash) {
      const restore = await stashPopBySha(cwd, pending.unstagedStash);
      if (restore.gone) {
        // It was restored/dropped manually. The staged snapshot is already
        // represented in the amended commit on a successful append, so remove
        // only its recovery copy and finish this transaction.
        await stashDropBySha(cwd, pending.changeStash);
        await this.clearPendingAppend(root);
        return true;
      }
      if (!restore.ok) {
        const name = await this.stashNameBySha(cwd, pending.unstagedStash);
        toast("warn", `恢复未暂存改动时有冲突：${restore.message}。安全副本 ${name}（stash: ${pending.unstagedStash.slice(0, 7)}）仍保留，请用 “git stash list” / “git stash pop ${name}” 手动恢复。`);
        return false;
      }
    }
    await stashDropBySha(cwd, pending.changeStash);
    await this.clearPendingAppend(root);
    return true;
  }

  /** Restores the original snapshot when setup failed before a pending record. */
  private async restoreAppendSnapshot(cwd: string, sha: string): Promise<void> {
    const restore = await stashApplyIndexBySha(cwd, sha);
    if (!restore.gone && !restore.ok) {
      const name = await this.stashNameBySha(cwd, sha);
      toast("warn", `恢复原始改动时有冲突：${restore.message}。安全副本 ${name}（stash: ${sha.slice(0, 7)}）仍保留，请用 “git stash list” / “git stash apply --index ${name}” 手动恢复。`);
      return;
    }
    await stashDropBySha(cwd, sha);
  }

  /**
   * Ensures a clean tree for a rebase. Returns true if the operation may
   * proceed. In auto-stash mode a dirty tree is stashed (recorded as pending so
   * it is popped on completion / Continue / Abort). In manual mode a dirty tree
   * blocks the operation with a warning.
   */
  private async prepareCleanTree(
    cwd: string,
    root: string
  ): Promise<{ proceed: boolean; stashed: boolean }> {
    if (!(await isDirty(cwd))) {
      return { proceed: true, stashed: false };
    }
    if (!getAutoStash()) {
      toast(
        "warn",
        "工作区/暂存区有未提交内容，无法执行该操作。请先点顶部 Stash 按钮或自行 git stash（或在设置中开启 autoStash）后再试。"
      );
      return { proceed: false, stashed: false };
    }
    const sha = await stashPush(cwd, "git-rebase-visual auto-stash");
    if (sha) {
      await this.setPendingStash(root, sha);
    }
    return { proceed: true, stashed: !!sha };
  }

  private async headTip(cwd: string): Promise<string | undefined> {
    const result = await runGit(["rev-parse", "HEAD"], { cwd });
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  /**
   * Audits patch-id locks after a completed rewrite. A normal replay is allowed:
   * its hash changes while its patch-id remains locked. If a direct or indirect
   * rewrite loses a locked patch instead, keep the original persisted lock and
   * make the existing private-ref Undo checkpoint immediately actionable.
   */
  private async warnMissingLockedPatches(
    cwd: string,
    root: string,
    beforeTip: string | undefined,
    undoRecord?: UndoRecord
  ): Promise<boolean> {
    const lockedPatchIds = this.locks.lockedPatchIds(root);
    if (lockedPatchIds.size === 0 || !beforeTip) {
      return false;
    }
    // Only locks reachable from the pre-rewrite tip are expected. The post
    // side must include all of HEAD, not just the divergent commits: Git can
    // skip an already-applied patch during rebase, leaving its equivalent patch
    // in the shared ancestry where it still correctly remains locked.
    const [before, after] = await Promise.all([
      runGit(["rev-list", beforeTip], { cwd }),
      runGit(["rev-list", "HEAD"], { cwd }),
    ]);
    if (before.code !== 0 || after.code !== 0) {
      this.log("lock", `改写后无法枚举 commit，跳过锁定 patch 连续性检查：${before.stderr || before.stdout || after.stderr || after.stdout}`);
      return false;
    }
    const beforeHashes = before.stdout.split(/\r?\n/).map((hash) => hash.trim()).filter(Boolean);
    const expectedPatchIds = new Set<string>();
    for (const hash of beforeHashes) {
      const patchId = await this.locks.computePatchId(cwd, hash);
      if (patchId && lockedPatchIds.has(patchId)) {
        expectedPatchIds.add(patchId);
      }
    }
    if (expectedPatchIds.size === 0) {
      return false;
    }
    const hashes = after.stdout.split(/\r?\n/).map((hash) => hash.trim()).filter(Boolean);
    const presentPatchIds = new Set<string>();
    for (const hash of hashes) {
      const patchId = await this.locks.computePatchId(cwd, hash);
      if (patchId && expectedPatchIds.has(patchId)) {
        presentPatchIds.add(patchId);
      }
    }
    const missing = this.locks.missingPatchIds(root, presentPatchIds, expectedPatchIds);
    if (missing.length === 0) {
      return false;
    }
    const short = missing.map((patchId) => patchId.slice(0, 10)).join("、");
    this.log("lock", `改写后未找到 ${missing.length} 个锁定 patch-id：${short}`);
    const message = undoRecord
      ? `改写后未找到 ${missing.length} 个锁定 patch（${short}）。原锁定记录已保留，避免该改动被静默解锁。请确认结果，或使用 Undo 恢复改写前历史。`
      : `改写后未找到 ${missing.length} 个锁定 patch（${short}）。原锁定记录已保留，避免该改动被静默解锁；此操作没有自动 Undo 检查点，请确认结果。`;
    const choice = undoRecord
      ? await vscode.window.showWarningMessage(message, "Undo")
      : await vscode.window.showWarningMessage(message);
    if (choice === "Undo" && undoRecord) {
      await this.undoLatest(cwd, undoRecord.id);
      return true;
    }
    return false;
  }

  /** Records a completed rewrite without offering an unsafe ORIG_HEAD reset. */
  private async reportRewrite(
    cwd: string,
    operation: string,
    oldTip: string | undefined,
    affectedCount: number,
    undoRecord?: UndoRecord
  ): Promise<boolean> {
    const newTip = await this.headTip(cwd);
    if (!newTip) {
      if (undoRecord) await this.undo.mark(undoRecord, "aborted");
      throw new Error("改写完成后无法读取 HEAD；Undo 记录未启用，以免错误回退。 ");
    }
    if (undoRecord) await this.undo.complete(undoRecord, newTip);
    const details = `${operation}; 范围 ${affectedCount} 个 commit; old tip ${oldTip ?? "unknown"}; new tip ${newTip}`;
    this.log("rebase", `完成 ${details}`);
    const undone = await this.warnMissingLockedPatches(cwd, this.root!, oldTip, undoRecord);
    if (undone) {
      return true;
    }
    const choice = await vscode.window.showInformationMessage(
      `${operation} 已完成：${oldTip?.slice(0, 10) ?? "unknown"} → ${newTip?.slice(0, 10) ?? "unknown"}（${affectedCount} 个 commit）。`,
      "Undo"
    );
    if (choice === "Undo") {
      await this.undoLatest(cwd, undoRecord?.id);
      return true;
    }
    return false;
  }

  private async runRebase(
    cwd: string,
    plan: {
      items: RebaseItem[];
      newMessage?: string;
      onto?: RebaseBase;
      operation?: string;
      affectedCount?: number;
    }
  ): Promise<{ ok: boolean; stopped: boolean } | undefined> {
    const root = this.root!;
    // Reject direct actions on a locked commit before preparing a clean tree:
    // otherwise a blocked drop could auto-stash user changes even though no Git
    // operation is allowed to run. A preceding edit/reword or an unlocked commit
    // moving across a lock may legitimately replay the locked patch under a new
    // hash. `runRebase` receives only the final todo, so it cannot tell that
    // permitted case from a source drag; source-lock validation remains in
    // handleReorder. Completed rewrites are audited by patch-id in reportRewrite.
    const originalItems = this.itemsWith();
    const originalHashes = new Set(originalItems.map((item) => item.hash));
    for (const proposed of plan.items) {
      if (!originalHashes.has(proposed.hash)) {
        throw new Error("变基计划包含未知 commit；未执行 Git 写入。");
      }
      if (proposed.action === "pick") {
        continue;
      }
      const pid = await this.locks.computePatchId(cwd, proposed.hash);
      if (this.locks.isLocked(root, proposed.hash, pid)) {
        toast("warn", "已锁定的 commit 不能删除或变更 rebase 操作；请先解除锁定。");
        return undefined;
      }
    }
    if (plan.items.length !== originalItems.length) {
      const proposedHashes = new Set(plan.items.map((item) => item.hash));
      for (const original of originalItems) {
        if (proposedHashes.has(original.hash)) {
          continue;
        }
        const pid = await this.locks.computePatchId(cwd, original.hash);
        if (this.locks.isLocked(root, original.hash, pid)) {
          toast("warn", "已锁定的 commit 不能从 rebase 计划中删除；请先解除锁定。");
          return undefined;
        }
      }
    }

    const prep = await this.prepareCleanTree(cwd, root);
    if (!prep.proceed) {
      return undefined;
    }

    const oldTip = await this.headTip(cwd);
    if (!oldTip) throw new Error("无法读取 rewrite 前的 HEAD，已取消操作。");
    const [branch, upstream] = await Promise.all([
      currentBranch(cwd), runGit(["rev-parse", "--verify", "--quiet", "@{upstream}"], { cwd }),
    ]);
    const rewritesPushed = upstream.code === 0 && (await isAncestor(cwd, oldTip, "@{upstream}"));
    if (rewritesPushed) {
      const confirmation = await vscode.window.showWarningMessage(
        "当前 HEAD 已推送到 upstream。此操作会改写共享历史；后续必须由你确认并使用 force-with-lease，插件不会自动推送。继续？",
        { modal: true },
        "仍要改写"
      );
      if (confirmation !== "仍要改写") {
        return undefined;
      }
    }
    const undoRecord = await this.undo.start(cwd, {
      operation: plan.operation ?? "变基",
      beforeTip: oldTip,
      branch,
      repository: root,
      affectedHashes: plan.items.map((item) => item.hash),
      affectedSteps: plan.affectedCount ?? plan.items.length,
    });
    const onto = plan.onto ?? (await this.computeBase(cwd));
    const { operation, affectedCount, ...rebasePlan } = plan;
    void operation;
    void affectedCount;
    const outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.SourceControl,
        title: `${plan.operation ?? "变基"}中…`,
        cancellable: false,
      },
      () => executeRebase(cwd, { ...rebasePlan, onto })
    );

    if (!outcome.ok && !outcome.stopped) {
      this.log("rebase", `失败 ${outcome.message}`);
      toast("error", `变基失败：${outcome.message}`);
      // Rebase did not apply; restore the stash immediately (silent if none).
      if (prep.stashed) {
        await this.popPendingStash(cwd, root);
      }
      await this.undo.mark(undoRecord, "aborted");
    } else if (outcome.stopped) {
      this.pendingRewrite = {
        operation: plan.operation ?? "变基",
        oldTip,
        affectedCount: plan.affectedCount ?? plan.items.length,
        undoRecord,
      };
      // Keep the pending stash; it is popped on Continue/Abort. Only mention
      // the stash when we actually created one.
      const conflicts = await conflictedFiles(cwd);
      const conflictHint = conflicts.length
        ? `冲突文件：${conflicts.join("、")}。`
        : "";
      this.log("rebase", outcome.message || "变基已暂停");
      toast(
        "warn",
        (prep.stashed
          ? "变基已暂停（冲突或 edit 停靠）。你的改动已自动 stash，将在 Continue/Abort 后自动恢复。"
          : "变基已暂停（冲突或 edit 停靠）。请解决后在面板 Continue 或 Abort。") + conflictHint
      );
      for (const file of conflicts) {
        void vscode.workspace.openTextDocument(vscode.Uri.file(path.join(cwd, file))).then(
          (document) => vscode.window.showTextDocument(document),
          () => undefined
        );
      }
    } else {
      if (prep.stashed) {
        // Completed cleanly — restore now.
        await this.popPendingStash(cwd, root);
      }
      const newTip = await this.headTip(cwd);
      if (oldTip !== newTip) {
        const undone = await this.reportRewrite(
          cwd,
          plan.operation ?? "变基",
          oldTip,
          plan.affectedCount ?? plan.items.length,
          undoRecord
        );
        if (undone) {
          await this.refresh();
        }
      } else {
        await this.undo.mark(undoRecord, "aborted");
        this.log("rebase", `${plan.operation ?? "变基"} 未改变 HEAD；未报告历史改写。`);
      }
    }
    return { ok: outcome.ok, stopped: outcome.stopped };
  }

  /**
   * Adds the current index to a selected commit. Git's equivalent is stopping
   * an interactive rebase at that commit, amending it, then replaying the later
   * commits. The original staged snapshot and any unrelated worktree changes
   * are restored safely around the rebase.
   */
  private async appendStagedToCommit(cwd: string, hash: string): Promise<void> {
    const status = await workingStatus(cwd);
    if (!status.hasStaged) {
      toast("warn", "暂存区没有可添加的文件。");
      return;
    }

    const commit = this.commits.find((c) => c.hash === hash);
    if (!commit) {
      throw new Error("找不到目标 commit，请刷新后重试。");
    }

    const patch = await this.locks.computePatchId(cwd, hash);
    if (this.locks.isLocked(this.root!, hash, patch)) {
      toast("warn", "目标 commit 已锁定。请先解除锁定，再追加暂存区文件。");
      return;
    }
    // Rejection guard: never amend a commit that is already on the local
    // upstream. Doing so would silently rewrite already-shared history, and the
    // later --force-with-lease push would abort (remote moved on) or clobber.
    const upstream = await runGit(["rev-parse", "--verify", "--quiet", "@{upstream}"], { cwd });
    const alreadyPushed =
      upstream.code === 0 && (await isAncestor(cwd, hash, "@{upstream}"));
    const pushedWarning = alreadyPushed
      ? "该 commit 已推送到 upstream，完成后需要使用 --force-with-lease 更新远端。"
      : "";
    const confirm = await vscode.window.showWarningMessage(
      `将暂存区文件追加到 ${commit.shortHash} “${commit.subject}”？这会改写该 commit 及其后的历史。${pushedWarning}`,
      { modal: true },
      ...(alreadyPushed ? ["取消", "我已推送同内容，仍要改写"] : ["追加"])
    );
    if (!alreadyPushed && confirm !== "追加") {
      return;
    }
    // Never force an append onto a commit that is already on upstream: the only
    // acceptable confirmation is the explicit "still rewrite" acknowledgment.
    if (alreadyPushed && confirm !== "我已推送同内容，仍要改写") {
      return;
    }

    // A rebase cannot start with a dirty tree. Saving the complete snapshot
    // first lets us restore the original index only after Git reaches the edit
    // stop. This avoids accidentally including later commit changes in amend.
    const changeStash = await stashPush(cwd);
    if (!changeStash) {
      toast("warn", "暂存区没有可添加的文件。");
      return;
    }

    let restoredForAmend = false;
    let undoRecord: UndoRecord | undefined;
    try {
      const oldTip = await this.headTip(cwd);
      if (!oldTip) throw new Error("无法读取 rewrite 前的 HEAD，已取消追加操作。");
      const branch = await currentBranch(cwd);
      undoRecord = await this.undo.start(cwd, {
        operation: "追加暂存区",
        beforeTip: oldTip,
        branch,
        repository: this.root!,
        affectedHashes: this.itemsWith().map((item) => item.hash),
        affectedSteps: this.commits.length,
      });
      const outcome = await executeRebase(cwd, {
        items: this.itemsWith((h) => (h === hash ? "edit" : undefined)),
        onto: await this.computeBase(cwd),
      });
      if (!outcome.stopped) {
        throw new Error(outcome.message || "未能在目标 commit 停靠，已取消追加操作。");
      }

      const stoppedAt = await rebaseStoppedSha(cwd);
      if (stoppedAt !== hash) {
        throw new Error("目标 commit 未停靠，已取消追加操作。");
      }

      const restore = await stashApplyIndexBySha(cwd, changeStash);
      if (restore.gone || !restore.ok) {
        throw new Error(
          restore.gone
            ? "暂存的改动已不存在，无法追加到目标 commit。"
            : `恢复暂存区失败：${restore.message}`
        );
      }

      await git(["commit", "--amend", "--no-edit"], { cwd });
      restoredForAmend = true;
      this.pendingRewrite = {
        operation: "追加暂存区",
        oldTip,
        affectedCount: this.commits.length,
        undoRecord,
      };

      // The amend consumed the index. If the user also had worktree-only
      // changes, move only those aside before Git replays following commits.
      const unstagedStash = status.hasUnstaged
        ? await stashPushKeepIndex(cwd)
        : undefined;
      await this.setPendingAppend(this.root!, {
        changeStash,
        unstagedStash,
        targetHash: hash,
        amended: true,
      });
      const continued = await continueRebase(cwd);
      if (!continued.ok) {
        throw new Error(continued.message || "继续变基失败。");
      }
      const appendRestored = await this.restorePendingAppend(cwd, this.root!);
      if (!appendRestored) {
        throw new Error("恢复追加前的工作区改动失败；请检查提示后手动恢复 stash。");
      }
      const pending = this.pendingRewrite;
      this.pendingRewrite = undefined;
      if (pending) {
        const undone = await this.reportRewrite(
          cwd,
          pending.operation,
          pending.oldTip,
          pending.affectedCount,
          pending.undoRecord
        );
        if (undone) {
          return;
        }
      }
      toast("info", `已将暂存区文件追加到 ${commit.shortHash}。`);
    } catch (e) {
      const inProgress = await isRebaseInProgress(cwd);
      if (inProgress) {
        // Preserve the paused rebase so the user can resolve a replay conflict
        // with the existing Continue / Abort controls. Before the amend, no
        // pending transaction exists yet, so an Abort would otherwise leave the
        // original snapshot stranded in stash.
        if (!restoredForAmend) {
          await this.setPendingAppend(this.root!, {
            changeStash,
            targetHash: hash,
            amended: false,
          });
          toast("warn", "追加已暂停；请解决冲突后 Continue 或 Abort。原始改动仍保存在 stash 中。");
        }
      } else if (!restoredForAmend) {
        await this.restoreAppendSnapshot(cwd, changeStash);
        this.pendingRewrite = undefined;
      }
      if (undoRecord) await this.undo.mark(undoRecord, "aborted");
      throw e;
    } finally {
      if (!(await isRebaseInProgress(cwd))) {
        await this.refresh();
      }
    }
  }

  private composeRevision(target: string): number {
    let revision = this.composeTargetRevisions.get(target);
    if (revision === undefined) {
      revision = this.nextComposeTargetRevision++;
      this.composeTargetRevisions.set(target, revision);
    }
    return revision;
  }

  /** Opens the compose dialog for a reword / AI / staged / working message. */
  private async openCompose(
    cwd: string,
    mode: string,
    hash: string | undefined,
    thenEdit: boolean,
    ai: boolean,
    messageOnly = false,
    editKind?: unknown
  ): Promise<void> {
    if (ai && !isLlmConfigured()) {
      toast("error",
        "请先在设置中配置 gitRebaseVisual.llm.baseUrl 与 apiKey。"
      );
      return;
    }
    if (!["commit", "staged", "working"].includes(mode)) {
      throw new Error("未知 Compose 模式，无法打开。 ");
    }
    const normalizedEditKind = editKind === "amend" || editKind === "new" ? editKind : undefined;
    let stoppedHash: string | undefined;
    if (await isRebaseInProgress(cwd)) {
      if (ai && !messageOnly) {
        throw new Error("变基进行中：不能调用 AI 生成 message；仅可保留 draft-only Compose。 ");
      }
      const editStopAmend = mode === "commit" && thenEdit === true && typeof hash === "string" && normalizedEditKind === "amend";
      const editStopNew = mode === "staged" && normalizedEditKind === "new" && ai === false;
      if (!isDraftOnlyComposeAllowedDuringRebase(mode, messageOnly) && !editStopAmend && !editStopNew) {
        throw new Error("变基进行中：不能打开 Compose 或生成 message。请先 Continue 或 Abort。 ");
      }
      if (editStopAmend || editStopNew) {
        await this.ensureEditStop(cwd);
        stoppedHash = await rebaseStoppedSha(cwd);
      }
      // The stopped hash is authority; never let a stale webview select a
      // different commit and amend whichever stop happens to be active.
      if (editStopAmend && hash !== stoppedHash) {
        throw new Error("目标 edit commit 已变化；未打开 Compose，请刷新后重试。");
      }
      // `new` has no commit hash, but it still belongs to this exact stopped
      // target. Carry it into the target revision so a later edit stop cannot
      // inherit or apply its earlier new-commit draft.
      if (editStopNew && !stoppedHash) {
        throw new Error("无法确认当前 edit 停靠目标；未打开新建 commit Compose。");
      }
    }
    let body = "";
    let trailers = "";
    let subject: string | undefined;
    if (mode === "commit" && hash) {
      // A stopped edit commit is detached from the normal range projection. It
      // remains valid only after ensureEditStop verified this exact Git state.
      const commit = this.commits.find((item) => item.hash === hash);
      if (!commit && !(thenEdit && stoppedHash === hash)) {
        throw new Error("目标 commit 已变化；请刷新后重新打开 Compose。");
      }
      const original = await fullMessage(cwd, hash);
      const split = splitTrailers(original);
      body = split.body;
      trailers = split.trailers;
      subject = commit?.subject ?? body.split(/\r?\n/, 1)[0];
    }
    // A staged/working Compose remains the same target across harmless view
    // refreshes, but changing its underlying diff invalidates a recovered draft.
    // Do not use refreshGeneration: it changes for unrelated file/UI updates.
    const changesRevision = mode === "staged"
      ? await getStagedDiff(cwd)
      : mode === "working"
        ? await getWorkingDiff(cwd)
        : undefined;
    const statusRevision = mode === "staged" || mode === "working"
      ? await workingStatus(cwd)
      : undefined;
    const targetRevision = mode === "commit" && hash
      ? `${hash}:${body}\0${trailers}`
      : stoppedHash
        ? `edit-stop:${stoppedHash}:${normalizedEditKind ?? "draft"}`
        : `${mode}:${changesRevision ?? ""}:${statusRevision?.hasStaged ? "staged" : ""}:${statusRevision?.hasUnstaged ? "unstaged" : ""}`;
    this.compose.open({
      mode,
      hash,
      thenEdit,
      ai,
      messageOnly,
      original: body,
      trailers,
      subject,
      editKind: normalizedEditKind,
      revision: this.composeRevision(targetRevision),
      model: getLlmConfig().model,
    });
  }

  /** Generates a message (batch) for a commit / staged / working diff. */
  private async generate(
    cwd: string,
    mode: string,
    hash: string | undefined,
    extra: string
  ): Promise<void> {
    if (!isLlmConfigured()) {
      toast("error", "请先配置 LLM。");
      return;
    }
    if (!["commit", "staged", "working"].includes(mode) || (mode === "commit" && !hash)) {
      throw new Error("未知 Compose 目标，不能生成 message。 ");
    }
    if (await isRebaseInProgress(cwd)) {
      throw new Error("变基进行中：不能生成 Compose message。请先 Continue 或 Abort。 ");
    }
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.SourceControl,
        title: "AI 生成 commit message 中…",
        cancellable: true,
      },
      async (_p, token) => {
        const ctrl = new AbortController();
        this.generationCancel = ctrl;
        token.onCancellationRequested(() => ctrl.abort());
        try {
          let text: string;
          const { timeout, ...extras } = getLlmExtras();
          const opts = { ...extras, extraInfo: extra };
          const onDelta = (chunk: string) => this.compose.post({ type: "genDelta", text: chunk });
          const requestOptions = { signal: ctrl.signal, timeout };
          if (mode === "commit" && hash) {
            text = await generateMessage(cwd, hash, getLlmConfig(), opts, onDelta, requestOptions);
          } else {
            const diff =
              mode === "staged"
                ? await getStagedDiff(cwd)
                : await getWorkingDiff(cwd);
            if (!diff.trim()) {
              toast("warn", "没有可用于生成的改动。");
              this.compose.post({ type: "genCancelled" });
              return;
            }
            text = await generateFromDiff(diff, getLlmConfig(), opts, onDelta, requestOptions);
          }
          this.compose.post({ type: "genResult", text: text || "" });
        } catch (e: any) {
          if (ctrl.signal.aborted) {
            // User cancelled — reset the panel's generate button.
            this.compose.post({ type: "genCancelled" });
            return;
          }
          this.compose.post({ type: "genError", message: String(e.message ?? e) });
        }
      }
    );
  }

  /** Applies a composed message: reword a commit, or commit staged/working. */
  private async apply(
    cwd: string,
    mode: string,
    hash: string | undefined,
    message: string,
    thenEdit: boolean,
    sessionId?: unknown,
    revision?: unknown
  ): Promise<void> {
    if (!message.trim()) {
      return;
    }
    if (await isRebaseInProgress(cwd)) {
      throw new Error("变基进行中：不能应用 Compose message。请先 Continue 或 Abort。 ");
    }
    if (mode === "commit" && hash) {
      // Preserve Change-Id / Signed-off-by trailers from the original message.
      const original = await fullMessage(cwd, hash);
      const finalMsg = applyTrailers(message, original);
      if (thenEdit) {
        const outcome = await this.runRebase(cwd, {
          items: this.itemsWith((h) => (h === hash ? "edit" : undefined)),
          operation: "编辑 message 后停靠",
          affectedCount: this.commits.length,
        });
        if (outcome?.stopped && (await isRebaseInProgress(cwd))) {
          const [stoppedAt, conflicts] = await Promise.all([
            rebaseStoppedSha(cwd),
            conflictedFiles(cwd),
          ]);
          if (stoppedAt !== hash || conflicts.length > 0) {
            throw new Error(
              "变基未能安全停靠在目标 commit；请先处理当前暂停状态。message 仍保留在对话框中。"
            );
          }
          await git(["commit", "--amend", "-F", "-"], { cwd, input: finalMsg });
        } else if (!outcome?.ok) {
          throw new Error("未能停靠在目标 commit，message 未应用。");
        }
      } else {
        const outcome = await this.runRebase(cwd, {
          items: this.itemsWith((h) => (h === hash ? "reword" : undefined)),
          newMessage: finalMsg,
          operation: "编辑 commit message",
          affectedCount: this.commits.length,
        });
        if (!outcome?.ok) {
          throw new Error(
            outcome?.stopped
              ? "变基已暂停，message 仍保留在对话框中。请先处理当前暂停状态。"
              : "编辑 commit message 未应用。"
          );
        }
      }
    } else if (mode === "staged") {
      if (!(await workingStatus(cwd)).hasStaged) {
        throw new Error("暂存区为空，message 未提交。 ");
      }
      await commitIndex(cwd, message.replace(/\s+$/, "") + "\n");
      toast("info", "已用生成的 message 提交暂存区改动。");
    } else if (mode === "working") {
      const status = await workingStatus(cwd);
      if (!status.hasStaged && !status.hasUnstaged) {
        throw new Error("工作区为空，message 未提交。 ");
      }
      await commitAll(cwd, message.replace(/\s+$/, "") + "\n");
      toast("info", "已暂存并提交工作区改动。");
    } else {
      throw new Error("未知 Compose 模式，message 未应用。 ");
    }
    await this.refresh();
    this.compose.clearDraft(sessionId, revision);
    this.compose.post({ type: "applySucceeded" });
  }

  private async openDiffDocument(cwd: string, hash: string): Promise<void> {
    // A controlled read-only virtual document avoids invoking private Git
    // extension commands and keeps binary/rename/root/merge output faithful.
    // Do not let a binary patch fill the extension-host heap: Git's complete
    // output is useful only while it fits within this deliberate display limit.
    const limit = 12 * 1024 * 1024;
    const result = await runGit(
      ["show", "--no-ext-diff", "--binary", "--find-renames", "--format=fuller", hash],
      { cwd, maxBuffer: limit }
    );
    if (result.code !== 0) {
      const message = result.stderr || result.stdout || "无法读取 commit diff。";
      if (message.includes("output limit")) {
        throw new Error("Commit diff 超过 12 MiB 显示上限；请在终端使用 git show 查看完整内容。 ");
      }
      throw new Error(message);
    }
    const document = await vscode.workspace.openTextDocument({ content: result.stdout, language: "diff" });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async sendDetail(cwd: string, hash: string): Promise<void> {
    try {
      const d = await commitDetail(cwd, hash);
      this.post({ type: "detail", hash, ...d });
    } catch {
      // ignore hover detail failures
    }
  }

  /** Command-palette/title entry point for the latest private-ref undo record. */
  public async undoLastRewrite(): Promise<void> {
    const cwd = this.cwd();
    if (cwd) {
      await this.undoLatest(cwd);
      await this.refresh();
    }
  }

  /** Manual stash of the working tree (default naming). For user-stash mode. */
  public async stashChanges(): Promise<void> {
    const cwd = this.cwd();
    if (!cwd) {
      return;
    }
    if (!(await isDirty(cwd))) {
      toast("info", "工作区干净，无需 stash。");
      return;
    }
    const sha = await stashPush(cwd, "git-rebase-visual manual stash");
    if (sha) {
      toast("info", "已 stash 未提交的改动。");
    }
    await this.refresh();
  }

  /**
   * Opens the "Git Stash" view or the Git Lens stash explorer when available;
   * falls back to listing stashes in the Output channel with the exact
   * `stash@{n}` names.
   */
  public async showStashList(): Promise<void> {
    // The Git extension may not be installed; `executeCommand` rejects for
    // unknown commands, so fall back to the Output-channel listing.
    try {
      const opened = await vscode.commands.executeCommand<boolean>("git.openStash");
      if (opened) {
        return;
      }
    } catch {
      // fall through to the local listing
    }
    const cwd = this.cwd();
    if (!cwd) {
      return;
    }
    const res = await runGit(["stash", "list", "--format=%gd %H %s"], { cwd });
    if (res.code !== 0 || !res.stdout.trim()) {
      toast("info", "没有可显示的 stash。");
      return;
    }
    this.log("stash", `stash list:\n${res.stdout.trim()}`);
    toast("info", "stash 列表已写入 Output 面板 (Git Rebase Visual)。");
  }

  /** Manual pop of the most recent stash. */
  public async popChanges(): Promise<void> {
    const cwd = this.cwd();
    if (!cwd) {
      return;
    }
    const res = await stashPopManual(cwd);
    if (res.empty) {
      toast("info", "没有可恢复的 stash。");
    } else if (!res.ok) {
      toast("warn", `git stash pop 有冲突：${res.message}`);
    } else {
      toast("info", "已恢复最近一次 stash。");
    }
    await this.refresh();
  }

  /**
   * Pushes the current HEAD. A plain push — the user rebases / edits beforehand
   * as needed, then pushes. Allowed even during a rebase (e.g. to push a commit
   * made at an `edit` stop): HEAD is detached then, so the upstream is resolved
   * via the branch being rebased. Applies the lock guard over `<upstream>..HEAD`
   * and supports a normal or review (refs/for/*) refspec.
   */
  public async pushBranch(): Promise<void> {
    if (this.busy) {
      toast("warn", "上一个操作尚未完成，请稍候。");
      return;
    }
    this.busy = true;
    try {
      await this.pushBranchInternal();
    } finally {
      this.busy = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }

  private async pushBranchInternal(): Promise<void> {
    const cwd = this.cwd();
    if (!cwd) {
      return;
    }
    // Determine the branch whose upstream we push to. Mid-rebase HEAD is
    // detached, so fall back to the branch being rebased.
    const inProgress = await isRebaseInProgress(cwd);
    const branch = inProgress
      ? await rebasingBranch(cwd)
      : await currentBranch(cwd);
    if (!branch) {
      toast("error", "无法确定当前分支（HEAD detached 且非变基状态）。");
      return;
    }
    const up = await getUpstream(cwd, branch);
    if (!up) {
      toast("error", `分支 ${branch} 未配置 upstream。`);
      return;
    }

    // Lock guard: reject if any locked commit is in <upstream>..HEAD.
    const blocked = await lockedInPush(
      cwd,
      up.ref,
      "HEAD",
      this.locks.lockedHashes(this.root!),
      this.locks.lockedPatchIds(this.root!)
    );
    if (blocked.length > 0) {
      const short = blocked.map((h) => h.slice(0, 7)).join(", ");
      toast("error", 
        `推送被拒绝：推送范围包含被锁定的 commit（${short}）。请将其移出推送范围（拖到你要推送的提交之后，或先 drop）再推送。`
      );
      return;
    }

    // Decide the refspec: normal branch push, or a configured review push.
    const template = getPushRefspecTemplate();
    let refspec = resolveRefspec(up, "HEAD", "");
    let label = `推送到 ${up.ref}`;
    if (template.trim()) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: "普通推送", detail: `HEAD → refs/heads/${up.branch}`, kind: "normal" },
          { label: "评审推送", detail: resolveRefspec(up, "HEAD", template), kind: "review" },
          { label: "自定义 refspec…", detail: "手动输入", kind: "custom" },
        ] as any,
        { placeHolder: "选择推送方式" }
      );
      if (!choice) {
        return;
      }
      if ((choice as any).kind === "review") {
        refspec = resolveRefspec(up, "HEAD", template);
        label = `评审推送 (${refspec})`;
      } else if ((choice as any).kind === "custom") {
        const input = await vscode.window.showInputBox({
          prompt: "输入 refspec（可用 ${tip} / ${branch} 占位符，${tip} 解析为 HEAD）",
          value: template,
        });
        if (!input) {
          return;
        }
        refspec = resolveRefspec(up, "HEAD", input);
        label = `自定义推送 (${refspec})`;
      }
    }

    // Show a hint when the user is pushing to a review ref while the API key is
    // only stored in settings (not yet migrated to SecretStorage) — the key may
    // be absent from the pushed ref's configured authentication.
    const secretApiKey = await SecretsAccessModule.get().get(LLM_APIKEY_SECRET);
    const reviewHint =
      /:refs\/for\//.test(refspec) && isLlmConfigured() && !secretApiKey
        ? "\n（提示：LLM API key 仍保存在 settings 中；若评审推送依赖该凭据，建议迁移到 SecretStorage。）"
        : "";
    const confirm = await vscode.window.showWarningMessage(
      `${label}？（${refspec}）${reviewHint}`,
      { modal: true },
      "Push"
    );
    if (confirm !== "Push") {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.SourceControl,
        title: `推送中：${refspec} → ${up.remote}`,
        cancellable: true,
      },
      async (_progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        this.log("push", `开始 ${up.remote} ${refspec}`);
        try {
          await pushRefspec(cwd, up, refspec, controller.signal);
          this.log("push", `完成 ${up.remote} ${refspec}`);
        } catch (error: any) {
          const message = String(error.message ?? error);
          this.log("push", `失败 ${message}`);
          if (controller.signal.aborted) {
            throw new Error("推送已取消。");
          }
          throw error;
        }
      }
    );
    toast("info", `已推送：${refspec} → ${up.remote}`);
    await this.refresh();
  }

  private html(webview: vscode.Webview): string {
    const mediaUri = vscode.Uri.joinPath(this.ctx.extensionUri, "media");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, "style.css"));
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>Git Rebase</title>
</head>
<body>
<div id="inline-toast" class="inline-toast hidden" role="status" aria-live="polite"></div>
<div id="banner" class="banner hidden" role="status" aria-live="polite"></div>
<div id="context" class="branch-context hidden"></div>
<div id="changes" class="changes hidden"></div>
<div id="direction" class="direction" role="status" aria-live="polite"></div>
<div id="list" class="list" role="list"></div>
<div id="menu" class="menu hidden" role="menu" aria-label="Commit 操作菜单"></div>
<div id="tooltip" class="tooltip hidden"></div>
<div id="dialog" class="dialog-backdrop hidden" role="presentation">
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-error">
    <div class="dialog-title" id="dialog-title">编辑 commit message</div>
    <div id="dialog-error" class="dialog-error hidden" role="alert"></div>

    <div id="orig-block" class="pane-block hidden">
      <div class="pane-label">
        <span>原始 message</span>
        <button id="orig-copy" class="link-btn">复制</button>
      </div>
      <textarea id="orig-text" class="pane readonly" readonly spellcheck="false"></textarea>
    </div>

    <div id="ai-block" class="ai-block hidden">
      <div class="pane-label">补充信息给 AI（可选，如链接、Issue 号等）</div>
      <textarea id="ai-extra" class="ai-extra" spellcheck="false"
        placeholder="例如：关联 IPCSDK-31159 ，或要求输出对应链接…"></textarea>
      <button id="ai-generate" class="btn primary small">生成 / 重新生成</button>
    </div>

    <div class="pane-label"><span id="result-label">Commit message</span></div>
    <textarea id="dialog-text" class="pane" spellcheck="false"></textarea>

    <div id="trailer-block" class="pane-block hidden">
      <div class="pane-label">保留的 trailer（Change-Id / Signed-off-by，不会被修改）</div>
      <pre id="trailer-text" class="trailer"></pre>
    </div>

    <div class="dialog-actions">
      <button id="dialog-cancel" class="btn">取消</button>
      <button id="dialog-ok" class="btn primary">应用</button>
    </div>
  </div>
</div>
<div id="live" class="sr-only" role="status" aria-live="polite"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/**
 * Success feedback belongs to the active rebase panel and is deliberately
 * short-lived. Warnings and errors are actionable system notifications: VS
 * Code owns their dismissal, rather than hiding them after an arbitrary timer.
 */
function toast(level: "info" | "warn" | "error", message: string, duration = 2500): void {
  if (level === "info") {
    if (inlineToastSink) {
      inlineToastSink(message, duration);
    } else {
      void vscode.window.showInformationMessage(message);
    }
    return;
  }
  if (level === "warn") {
    void vscode.window.showWarningMessage(message);
  } else {
    void vscode.window.showErrorMessage(message);
  }
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
