import * as vscode from "vscode";
import * as path from "path";
import {
  Commit,
  getCommits,
  resolveRange,
  isRebaseInProgress,
  rebaseStoppedSha,
  rebaseAtEditStop,
  rebaseTodoFiles,
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
import { currentCommitSelection, rebaseProgressState } from "./rebaseState";
import { branchContext } from "./rebasePresentation";
import {
  deleteUntrackedWorktreeChange,
  discardAllWorktreeChanges,
  getWorktreeChanges,
  restoreWorktreeChange,
  stageAllWorktreeChanges,
  stageWorktreeChange,
  unstageAllWorktreeChanges,
} from "../git/worktreeChanges";
import { requiresCurrentCommitHash, webviewMessageIntent } from "./webviewProtocolState";
import { mutationGateDecision } from "./mutationGate";
import { openCommitFileDiff, openWorktreeDiff } from "./worktreeDiff";
import { GitContentRequestStore } from "./gitDiffRequestState";
import { GeneratedDiffSnapshotStore } from "./generatedDiffDocument";
import { generatedDiffUri } from "./generatedDiffProvider";
import {
  buildGeneratedDiffSnapshot,
  generatedDiffCommits,
  generatedDiffRequestIsCurrent,
} from "./generatedDiffState";
import { applyCommitBinaryStatus, commitDiffPlan, parseCommitChangedFiles } from "./commitDiffState";
import { ensureEditStopTarget, writeEditStopCommit } from "./editStopCommit";
import { validateReorderRequest } from "./rebaseReorderState";
import { nativeTreeDropAtEndIntent, nativeTreeDropIntent } from "./rebasePointerDragState";
import { nextCanonicalSnapshotRevision } from "./canonicalSnapshot";
import { isDraftOnlyAiGenerationAllowedDuringRebase, isDraftOnlyComposeAllowedDuringRebase, nativeWorkingAiComposeRequest } from "./composePolicy";
import { ComposePanel } from "./composePanel";
import {
  NativeCommitTreeElement,
  NativeCommitTreeProvider,
  nativeCommitTreeMime,
  nativeCommitTreeViewId,
} from "./nativeCommitTree";
import { CommitDetailCache } from "./commitDetailCache";
import { nativeCommandIntent } from "./nativeCommandIntent";
import { refreshFeedback } from "./refreshFeedbackPolicy";
import { UndoJournal, UndoRecord, undoPreflight } from "../git/undo";

const PENDING_STASH_KEY = "gitRebaseVisual.pendingStash";
const PENDING_APPEND_KEY = "gitRebaseVisual.pendingAppend";

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

export class RebaseViewProvider {
  public static readonly viewType = nativeCommitTreeViewId;

  private readonly treeProvider = new NativeCommitTreeProvider();
  private readonly tree: vscode.TreeView<NativeCommitTreeElement>;
  private nativeSelectionHashes = new Set<string>();
  private commits: Commit[] = [];
  private root?: string;
  private busy = false;
  private refreshQueued = false;
  private refreshGeneration = 0;
  /** Revision of the last fully published actionable commit snapshot. */
  private canonicalRevision = 0;
  /** Equality key for the current history/range/rebase/lock safety snapshot. */
  private canonicalSnapshotKey?: string;
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
  private readonly commitDiffCache = new Map<string, ReturnType<typeof commitDiffPlan>>();
  /** Immutable commit tooltip metadata, fetched lazily once rather than per poll. */
  private readonly commitDetailCache = new CommitDetailCache<Awaited<ReturnType<typeof commitDetail>>>(64);

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly locks: LockStore,
    private readonly diffRequests: GitContentRequestStore,
    private readonly generatedDiffSnapshots: GeneratedDiffSnapshotStore
  ) {
    this.output = vscode.window.createOutputChannel("Git Rebase Visual");
    this.undo = new UndoJournal(ctx.workspaceState, ctx.globalState);
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.command = "gitRebaseVisual.reveal";
    this.statusBar.tooltip = "显示 Git Rebase Visual";
    this.compose = new ComposePanel(ctx.extensionUri, (message) => this.onMessage(message));
    this.tree = vscode.window.createTreeView(RebaseViewProvider.viewType, {
      treeDataProvider: this.treeProvider,
      showCollapseAll: false,
      canSelectMany: true,
      dragAndDropController: this.nativeDragAndDropController(),
    });
    ctx.subscriptions.push(this.output, this.statusBar, this.compose, this.treeProvider, this.tree, new vscode.Disposable(() => {
      this.commitDiffCache.clear();
      this.commitDetailCache.clear();
      this.generatedDiffSnapshots.clear();
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
      this.tree.onDidChangeVisibility(() => {
        if (this.tree.visible) {
          this.startStatusPolling();
          void this.refresh();
        } else {
          this.stopStatusPolling();
        }
      }),
      this.tree.onDidChangeSelection((event) => {
        this.nativeSelectionHashes = new Set(event.selection
          .filter((item): item is Extract<NativeCommitTreeElement, { kind: "commit" }> => item.kind === "commit")
          .map((item) => item.commit.hash));
        const order = this.commits.slice().reverse().map((commit) => commit.hash);
        const indices = order.map((hash, index) => this.nativeSelectionHashes.has(hash) ? index : -1).filter((index) => index >= 0);
        const contiguous = indices.length < 2 || indices.at(-1)! - indices[0]! + 1 === indices.length;
        const hasLocked = [...this.nativeSelectionHashes].some((hash) => this.lockedHashes.has(hash));
        this.treeProvider.setSelection({ hashes: this.nativeSelectionHashes, contiguous, hasLocked });
        for (const item of event.selection) {
          if (item.kind !== "commit" || item.detail || !this.root) continue;
          const root = this.root;
          const hash = item.commit.hash;
          void this.commitDetailCache.getOrLoad(`${root}:${hash}`, () => commitDetail(root, hash)).then(
            (detail) => this.treeProvider.setCommitDetail(hash, detail),
            () => undefined // concise commit data remains an accurate fallback tooltip
          );
        }
      }),
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

  /** Starts native-tree refreshes after activation without creating a webview. */
  public start(): void {
    this.startStatusPolling();
    void this.refresh();
  }

  private stopStatusPolling(): void {
    if (this.statusPoller) {
      clearInterval(this.statusPoller);
      this.statusPoller = undefined;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.statusPollerStarted = false;
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
      } else {
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

  /** User-initiated title/command refresh with quiet polling kept separate. */
  public async refreshFromCommand(): Promise<void> {
    await this.refresh();
    const feedback = refreshFeedback("command");
    if (feedback) toast("info", feedback);
  }

  public async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration;
    const isCurrent = () => generation === this.refreshGeneration;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
      this.tree.message = "No workspace folder open.";
      this.treeProvider.setElements([]);
      return;
    }
    const root = await repoRoot(folder);
    if (!root) {
      this.tree.message = "Not a git repository.";
      this.treeProvider.setElements([]);
      return;
    }
    if (!isCurrent()) {
      return;
    }
    if (this.root && this.root !== root) {
      this.diffRequests.invalidateRepository(this.root);
      this.generatedDiffSnapshots.invalidateRepository(this.root);
      this.commitDiffCache.clear();
      this.commitDetailCache.clear();
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
      this.tree.message = gitOk.message ?? "Git 环境异常。";
      this.treeProvider.setElements([]);
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
      this.tree.message = range.error;
      this.treeProvider.setElements([]);
      return;
    }

    let commits: Commit[];
    try {
      commits = await getCommits(root, range.revRange);
    } catch (e: any) {
      this.tree.message = String(e.message ?? e);
      this.treeProvider.setElements([]);
      return;
    }

    const [stoppedAt, atEditStop, conflictPaths, todoFiles] = rebaseInProgress
      ? await Promise.all([
          rebaseStoppedSha(root),
          rebaseAtEditStop(root),
          conflictedFiles(root),
          rebaseTodoFiles(root),
        ])
      : [undefined, false, [] as string[], {}];
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

    const [status, changes] = await Promise.all([workingStatus(root), getWorktreeChanges(root)]);
    if (!isCurrent()) {
      return;
    }
    this.commits = commits;
    this.lockedHashes = new Set(
      commits.filter((commit) => lockedFlags.get(commit.hash)).map((commit) => commit.hash)
    );
    // A status poll runs every 1.5s. It must not invalidate a normal drag merely
    // because worktree counters or presentation details refreshed. Revisions only
    // advance when the actionable history snapshot itself changed.
    const snapshot = nextCanonicalSnapshotRevision(
      { key: this.canonicalSnapshotKey, revision: this.canonicalRevision },
      {
        repository: root,
        branch,
        range: range.revRange,
        rebaseInProgress,
        hashesNewestFirst: commits.map((commit) => commit.hash),
        lockedHashes: this.lockedHashes,
      }
    );
    this.canonicalSnapshotKey = snapshot.key;
    this.canonicalRevision = snapshot.revision;

    // TreeView rows are native workbench items. Their context menu and tooltip
    // are rendered by VS Code outside any webview iframe, so the menu naturally
    // anchors at the pointer, can overlap editor content, and closes on Escape.
    const ordered = [...commits].reverse();
    const elements: NativeCommitTreeElement[] = [];
    const branchDescription = presentation.branchName
      ? `${presentation.branchName} · ${presentation.upstreamRef ?? "no upstream"} · ↑${presentation.aheadCount ?? 0} ↓${presentation.behindCount ?? 0}`
      : undefined;
    if (branchDescription) {
      elements.push({ kind: "message", label: branchDescription, tooltip: `${presentation.rangeLabel ?? ""} · ↑ Base / 较早` });
    } else {
      elements.push({ kind: "message", label: "↑ Base / 较早" });
    }

    // A status poll can run every 1.5 seconds. Commit objects are immutable, so
    // populate only uncached visible tooltip details and never wait on one Git
    // subprocess per row before rendering the actionable native TreeView.
    const details = new Map<string, Awaited<ReturnType<typeof commitDetail>>>();
    for (const commit of ordered) {
      const detail = this.commitDetailCache.get(`${root}:${commit.hash}`);
      if (detail) details.set(commit.hash, detail);
    }
    const commitItems = ordered.map((commit) => ({
      kind: "commit" as const,
      commit,
      locked: lockedFlags.get(commit.hash) ?? false,
      stopped: progress.pausedReason === "edit" && stoppedAt === commit.hash,
      pending: progress.pendingHashes?.some((hash) => commit.hash.startsWith(hash) || hash.startsWith(commit.hash)) ?? false,
      detail: details.get(commit.hash),
    }));
    this.appendNativeCommitItems(elements, commitItems);

    if (rebaseInProgress) {
      const stoppedCommit = commitItems.find((item) => item.stopped);
      const pausedLabel = progress.pausedReason === "conflict"
        ? `变基暂停：${progress.conflictCount} 个冲突文件 · Continue / Skip / Abort`
        : progress.pausedReason === "edit"
          ? `变基停靠 (edit)：${stoppedCommit?.commit.shortHash ?? "当前 commit"} · Amend / 新建 commit / 草稿 / Continue / Abort`
          : "变基进行中：Continue / Abort";
      elements.push({
        kind: "message",
        label: pausedLabel,
        tooltip: progress.pausedReason === "conflict"
          ? `请解决并暂存冲突：${progress.conflictFiles.join("、")}`
          : "在此原生树项目右键使用 rebase 操作。",
        context: progress.pausedReason === "edit" ? "editStop" : "rebase",
        rebase: {
          pausedReason: progress.pausedReason,
          conflictCount: progress.conflictCount,
          stoppedCommit,
          hasStaged: status.hasStaged,
          llmConfigured: isLlmConfigured(),
        },
      });
    }
    if (changes.length) {
      const staged = changes.filter((item) => item.staged);
      const working = changes.filter((item) => item.unstaged);
      if (staged.length) {
        elements.push({ kind: "message", label: `Staged Changes (${staged.length}) · 右键：撤销全部暂存 / AI 生成 message 并提交`, tooltip: "右键此标题管理已暂存文件。", context: "worktreeStaged" });
        for (const change of staged) elements.push({ kind: "worktree", change, side: "staged" });
      }
      if (working.length) {
        elements.push({ kind: "message", label: `Changes (${working.length}) · 右键：暂存全部 / 恢复全部 / AI 生成 message`, tooltip: "右键此标题管理工作区文件；未跟踪文件可在其行右键删除。", context: "worktreeWorking" });
        for (const change of working) elements.push({ kind: "worktree", change, side: "working" });
      }
    }
    this.tree.message = undefined;
    this.tree.description = rebaseInProgress ? `rebase · ${progress.pausedReason ?? "进行中"}` : branchDescription;
    this.tree.badge = { value: commits.length, tooltip: `${commits.length} commits · ↑ Base / 较早 · ↓ HEAD / 较新` };
    this.treeProvider.setElements(elements);
  }

  /** Preserves the legacy collapse behavior as a real native TreeView parent. */
  private appendNativeCommitItems(
    elements: NativeCommitTreeElement[],
    commits: Array<Extract<NativeCommitTreeElement, { kind: "commit" }>>
  ): void {
    let index = 0;
    while (index < commits.length) {
      const current = commits[index];
      if (getCollapseLockedRuns() && current.locked && !current.stopped && !current.pending) {
        let end = index + 1;
        while (end < commits.length && commits[end].locked && !commits[end].stopped && !commits[end].pending) end += 1;
        if (end - index >= 3) {
          elements.push({ kind: "lockedRun", commits: commits.slice(index, end) });
          index = end;
          continue;
        }
      }
      elements.push(current);
      index += 1;
    }
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

  /** Runs a native TreeView command through the same serialized host safety gate. */
  private async onNativeCommand(type: string, element?: NativeCommitTreeElement): Promise<void> {
    const intent = nativeCommandIntent(
      type,
      element,
      this.canonicalRevision,
      (type === "bulkLock" || type === "bulkDrop" || type === "bulkGenerateDiff") ? this.nativeSelectedHashes(element) : []
    );
    if (!intent) return;
    await this.onMessage({ ...intent, source: "native-tree" });
  }

  private nativeSelectedHashes(element?: NativeCommitTreeElement): string[] {
    const selected = this.nativeSelectionHashes.size > 1
      ? [...this.nativeSelectionHashes]
      : element?.kind === "commit" ? [element.commit.hash] : [];
    return this.commits.slice().reverse().map((commit) => commit.hash).filter((hash) => selected.includes(hash));
  }

  private nativeDragAndDropController(): vscode.TreeDragAndDropController<NativeCommitTreeElement> {
    return {
      dragMimeTypes: [nativeCommitTreeMime],
      dropMimeTypes: [nativeCommitTreeMime],
      handleDrag: (source, transfer) => {
        const commits = source.filter((item): item is Extract<NativeCommitTreeElement, { kind: "commit" }> => item.kind === "commit");
        if (commits.length !== 1 || commits[0].locked) return;
        transfer.set(nativeCommitTreeMime, new vscode.DataTransferItem(JSON.stringify({
          hash: commits[0].commit.hash,
          revision: this.canonicalRevision,
          order: this.commits.slice().reverse().map((commit) => commit.hash),
        })));
      },
      handleDrop: async (target, transfer) => {
        const data = transfer.get(nativeCommitTreeMime);
        if (!data) return;
        let drag: { hash?: unknown; revision?: unknown; order?: unknown };
        try {
          drag = JSON.parse(await data.asString()) as typeof drag;
        } catch {
          return;
        }
        if (typeof drag.hash !== "string" || typeof drag.revision !== "number") return;
        const canonicalOrder = this.commits.slice().reverse().map((commit) => commit.hash);
        const sourceIndex = canonicalOrder.indexOf(drag.hash);
        if (sourceIndex < 0) return;

        // Dropping in native TreeView's empty lower area represents the explicit
        // final boundary. It still carries the newest real commit as an anchor,
        // preserving host-side canonical/revision/lock validation.
        const intent = target === undefined
          ? nativeTreeDropAtEndIntent(drag.hash, canonicalOrder, drag.revision, this.lockedHashes)
          : target.kind === "commit" && !target.locked && canonicalOrder.indexOf(target.commit.hash) >= 0
            ? nativeTreeDropIntent(drag.hash, target.commit.hash, canonicalOrder, drag.revision)
            : undefined;
        // Native DnD never inserts a hint/list row during drag. On drop it sends
        // only the full captured canonical intent, which handleReorder rechecks.
        if (!intent) return;
        await this.onMessage({ type: "reorder", source: "native-tree", ...intent });
      },
    };
  }

  /** Command registrations are intentionally explicit: context menus are native UI. */
  public nativeCommand(command: string, element?: NativeCommitTreeElement): Promise<void> {
    switch (command) {
      case "copyHash":
        return this.onNativeCommand("copyHash", element);
      case "copyMessage":
        return this.onNativeCommand("copyMessage", element);
      case "openDiff":
        return this.onNativeCommand("openDiff", element);
      case "generateDiff":
        return this.onNativeCommand("generateDiff", element);
      case "drop":
        return this.onNativeCommand("drop", element);
      case "squash":
        return this.onNativeCommand("squash", element);
      case "fixup":
        return this.onNativeCommand("fixup", element);
      case "lock":
        return this.onNativeCommand("lock", element);
      case "unlock":
        return this.onNativeCommand("unlock", element);
      case "rebaseTo":
        return this.onNativeCommand("rebaseTo", element);
      case "appendStaged":
        return this.onNativeCommand("appendStaged", element);
      case "reword":
        if (element?.kind !== "commit") return Promise.resolve();
        return this.onMessage({ type: "openCompose", source: "native-tree", mode: "commit", hash: element.commit.hash, ai: false, thenEdit: false });
      case "aiMessage":
        if (element?.kind !== "commit") return Promise.resolve();
        return this.onMessage({ type: "openCompose", source: "native-tree", mode: "commit", hash: element.commit.hash, ai: true, thenEdit: false });
      case "openWorktreeDiff":
        return this.onNativeCommand("openWorktreeDiff", element);
      case "stageFile":
        return this.onNativeCommand("stageFile", element);
      case "restoreFile":
        return this.onNativeCommand("restoreFile", element);
      case "deleteUntrackedFile":
        return this.onNativeCommand("deleteUntrackedFile", element);
      case "bulkLock":
        return this.onNativeCommand("bulkLock", element);
      case "bulkDrop":
        return this.onNativeCommand("bulkDrop", element);
      case "bulkGenerateDiff":
        return this.onNativeCommand("bulkGenerateDiff", element);
      case "continueRebase":
        return this.onNativeCommand("continueRebase", element);
      case "abortRebase":
        return this.onNativeCommand("abortRebase", element);
      case "skipRebase":
        return this.onNativeCommand("skipRebase", element);
      case "editStopAmend":
        if (element?.kind !== "message" || !element.rebase?.stoppedCommit) return Promise.resolve();
        return this.onMessage({ type: "openCompose", source: "native-tree", mode: "commit", hash: element.rebase.stoppedCommit.commit.hash, ai: false, thenEdit: true, editKind: "amend" });
      case "editStopNew":
        return this.onMessage({ type: "openCompose", source: "native-tree", mode: "staged", ai: false, thenEdit: false, editKind: "new" });
      case "editStopDraft":
        if (element?.kind !== "message" || !element.rebase?.hasStaged) return Promise.resolve();
        return this.onMessage({ type: "openCompose", source: "native-tree", mode: "staged", ai: true, thenEdit: false, messageOnly: true });
      case "stageAllFiles":
        return this.onNativeCommand("stageAllFiles", element);
      case "discardAllFiles":
        return this.onNativeCommand("discardAllFiles", element);
      case "unstageAllFiles":
        return this.onNativeCommand("unstageAllFiles", element);
      case "stagedAiMessage":
        if (element?.kind !== "message") return Promise.resolve();
        return this.onMessage({ type: "openCompose", source: "native-tree", mode: "staged", ai: true, thenEdit: false });
      case "workingAiMessage":
        return this.openWorkingAiCompose(element);
      default:
        return Promise.resolve();
    }
  }

  /** Opens working-tree AI compose while preserving its paused-rebase draft policy. */
  private async openWorkingAiCompose(element?: NativeCommitTreeElement): Promise<void> {
    if (element?.kind !== "message") return;
    // Working-section headers are not themselves paused-rebase message rows, so
    // query the authoritative Git state rather than inferring policy from their
    // presentation data. `openCompose` independently rechecks this before use.
    const cwd = this.cwd();
    const rebaseInProgress = !!cwd && await isRebaseInProgress(cwd);
    const request = nativeWorkingAiComposeRequest(isLlmConfigured(), rebaseInProgress);
    if (!request) {
      toast("error", "请先在设置中配置 gitRebaseVisual.llm.baseUrl 与 apiKey。");
      return;
    }
    await this.onMessage({ ...request, source: "native-tree" });
  }

  private async onMessage(m: FromWebview): Promise<void> {
    const source = typeof m.source === "string" ? m.source : "webview:unknown";
    const intent = webviewMessageIntent(m.type);
    // Source/action diagnostics make accidental webview traffic traceable while
    // preserving a quiet host for scroll, pointer, focus, IME and toast events.
    this.log("webview", `${source} action=${m.type} intent=${intent}`);
    const gate = mutationGateDecision(m.type, { busy: this.busy, pausedRebase: false });
    if (gate.kind === "busy") {
      toast("warn", "上一个操作尚未完成，请稍候。");
      return;
    }
    if (intent === "mutation") {
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
    // Worktree actions identify a path instead of a commit and revalidate that
    // path against a fresh porcelain status read in their own handlers.
    if (requiresCurrentCommitHash(m) && !this.isCurrentCommitHash(m.hash)) {
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
      // `stageFile` and `restoreFile` are explicit pause-policy entries. Their
      // mutation classification above ensures they are still serialized by busy.
      const draftOnlyCompose =
        m.type === "openCompose" &&
        isDraftOnlyComposeAllowedDuringRebase(m.mode, m.messageOnly === true);
      const activeCompose = this.compose.activeSession();
      const draftOnlyGeneration =
        m.type === "generate" &&
        !!activeCompose &&
        this.compose.acceptsActiveSession(m.sessionId, m.revision) &&
        activeCompose.mode === m.mode &&
        activeCompose.messageOnly === true &&
        isDraftOnlyComposeAllowedDuringRebase(activeCompose.mode, true);
      const editStopCompose =
        m.type === "openCompose" && m.mode === "commit" && m.thenEdit === true && typeof m.hash === "string";
      const editStopNewCompose =
        m.type === "openCompose" && m.mode === "staged" && m.editKind === "new" && m.ai !== true;
      const editStopDraftCompose =
        m.type === "openCompose" && m.messageOnly === true && isDraftOnlyComposeAllowedDuringRebase(m.mode, true);
      const pausedException =
        draftOnlyCompose || draftOnlyGeneration || editStopCompose || editStopNewCompose || editStopDraftCompose;
      // Reuse the actual gate policy: stage/restore are explicit allow-list
      // writes, while draft/edit-stop exceptions remain intentionally narrow.
      const pausedUnsafeMutation = mutationGateDecision(
        m.type,
        { busy: false, pausedRebase: true },
        { pausedException }
      ).kind === "blockedPaused";
      if (pausedUnsafeMutation) {
        const message = "变基进行中：此操作不能在当前暂停状态执行。";
        if (m.type === "apply") this.compose.post({ type: "applyFailed", message });
        vscode.window.showWarningMessage(message);
        return;
      }
    }
    try {
      switch (m.type) {
        case "ready":
          await this.refresh();
          break;
        case "refresh":
          await this.refresh();
          const feedback = refreshFeedback("webview");
          if (feedback) toast("info", feedback);
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
          await this.openCommitDiff(cwd!, m.hash);
          break;
        case "generateDiff":
          await this.generateCommitDiffDocument(cwd!, [m.hash], m.revision);
          break;
        case "bulkGenerateDiff": {
          const hashes = this.selectedHashes(m.hashes);
          if (!hashes) throw new Error("选择已过期；请刷新后重试。 ");
          await this.generateCommitDiffDocument(cwd!, hashes, m.revision);
          break;
        }
        case "openWorktreeDiff":
          await this.openChangedFileDiff(cwd!, m.path);
          break;
        case "stageFile":
          await this.stageChangedFile(cwd!, m.path);
          break;
        case "restoreFile":
          await this.restoreChangedFile(cwd!, m.path, m.side);
          break;
        case "deleteUntrackedFile":
          await this.deleteUntrackedChangedFile(cwd!, m.path);
          break;
        case "stageAllFiles":
          await this.stageAllChangedFiles(cwd!);
          break;
        case "discardAllFiles":
          await this.discardAllChangedFiles(cwd!);
          break;
        case "unstageAllFiles":
          await this.unstageAllChangedFiles(cwd!);
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
          await this.generate(cwd!, m.mode, m.hash, m.extra ?? "", m.sessionId, m.revision);
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
      this.canonicalRevision,
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
      this.canonicalRevision,
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
      // AI is permitted only in the explicitly draft-only surface. It produces
      // text, never a Git write; amend/new routes remain guarded below.
      if (ai && !messageOnly) {
        throw new Error("变基进行中：AI 仅可在“仅生成 message，不提交”模式中生成草稿。 ");
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
    extra: string,
    sessionId?: unknown,
    revision?: unknown
  ): Promise<void> {
    if (!isLlmConfigured()) {
      toast("error", "请先配置 LLM。");
      return;
    }
    if (!this.compose.acceptsActiveSession(sessionId, revision)) {
      this.compose.post({ type: "genError", message: "Compose 会话已过期；未发送 AI 请求，请重新打开草稿。" });
      return;
    }
    if (!["commit", "staged", "working"].includes(mode) || (mode === "commit" && !hash)) {
      throw new Error("未知 Compose 目标，不能生成 message。 ");
    }
    if (await isRebaseInProgress(cwd)) {
      const active = this.compose.activeSession();
      const hasConflicts = (await conflictedFiles(cwd)).length > 0;
      if (!active || active.mode !== mode || !isDraftOnlyAiGenerationAllowedDuringRebase(active.mode, active.messageOnly === true, hasConflicts)) {
        throw new Error(hasConflicts
          ? "变基存在冲突：改动尚不稳定，不能生成 commit message 草稿。请先解决冲突。 "
          : "变基进行中：仅可为当前 staged/working 的“仅生成 message，不提交”草稿生成 AI message。 ");
      }
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
          const onDelta = (chunk: string) => {
            if (this.compose.acceptsActiveSession(sessionId, revision)) this.compose.post({ type: "genDelta", text: chunk });
          };
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
          if (this.compose.acceptsActiveSession(sessionId, revision)) {
            this.compose.post({ type: "genResult", text: text || "" });
          }
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

  /** Opens a structured working-tree entry through a controlled public-API diff. */
  private async openChangedFileDiff(cwd: string, pathValue: unknown): Promise<void> {
    if (typeof pathValue !== "string") throw new Error("缺少要比较的文件路径。 ");
    const change = (await getWorktreeChanges(cwd)).find((item) => item.path === pathValue);
    if (!change) throw new Error("文件状态已变化；请刷新后重试。 ");
    const result = await openWorktreeDiff(this.diffRequests, cwd, change);
    if (result.fallback) toast("warn", result.fallback);
  }

  /** Stages exactly the displayed working/untracked change after a fresh status read. */
  private async stageChangedFile(cwd: string, pathValue: unknown): Promise<void> {
    if (typeof pathValue !== "string") throw new Error("缺少要暂存的文件路径。 ");
    const change = (await getWorktreeChanges(cwd)).find((item) => item.path === pathValue);
    if (!change) throw new Error("文件状态已变化；请刷新后重试。 ");
    await stageWorktreeChange(cwd, change);
    toast("info", `已暂存 ${change.path}。`);
    await this.refresh();
  }

  /** Stages every working-tree side after a host-side fresh porcelain read. */
  private async stageAllChangedFiles(cwd: string): Promise<void> {
    const changes = await getWorktreeChanges(cwd);
    await stageAllWorktreeChanges(cwd, changes);
    toast("info", "已暂存全部工作区改动。 ");
    await this.refresh();
  }

  /** Discards all visible working sides only after a host-side modal confirmation. */
  private async discardAllChangedFiles(cwd: string): Promise<void> {
    const changes = await getWorktreeChanges(cwd);
    if (!changes.some((change) => change.unstaged)) throw new Error("没有可恢复的工作区改动。 ");
    const confirm = await vscode.window.showWarningMessage(
      "恢复全部工作区改动？未暂存改动将丢弃；未跟踪文件将从磁盘删除。",
      { modal: true },
      "恢复全部"
    );
    if (confirm !== "恢复全部") return;
    // Status can have changed while the modal was open. Re-read before deletion.
    await discardAllWorktreeChanges(cwd, await getWorktreeChanges(cwd));
    toast("info", "已恢复全部工作区改动。 ");
    await this.refresh();
  }

  /** Removes all index entries while preserving working-tree content. */
  private async unstageAllChangedFiles(cwd: string): Promise<void> {
    const changes = await getWorktreeChanges(cwd);
    if (!changes.some((change) => change.staged)) throw new Error("暂存区为空。 ");
    const confirm = await vscode.window.showWarningMessage(
      "撤销全部暂存？工作区内容不会改变。",
      { modal: true },
      "撤销全部暂存"
    );
    if (confirm !== "撤销全部暂存") return;
    await unstageAllWorktreeChanges(cwd, await getWorktreeChanges(cwd));
    toast("info", "已撤销全部暂存；工作区内容未改变。 ");
    await this.refresh();
  }

  /** Restores only a tracked staged/working side after fresh host-side status. */
  private async restoreChangedFile(
    cwd: string,
    pathValue: unknown,
    sideValue: unknown,
  ): Promise<void> {
    if (typeof pathValue !== "string" || (sideValue !== "working" && sideValue !== "staged")) {
      throw new Error("缺少要恢复的文件状态。 ");
    }
    const change = (await getWorktreeChanges(cwd)).find((item) => item.path === pathValue);
    if (!change) throw new Error("文件状态已变化；请刷新后重试。 ");
    if (sideValue === "working" && change.worktreeKind === "untracked") {
      throw new Error("未跟踪文件必须使用“删除未跟踪文件”操作。 ");
    }
    const action = sideValue === "working" ? "丢弃该文件未暂存的工作区改动" : "撤销该文件的暂存（工作区内容保留）";
    const confirm = await vscode.window.showWarningMessage(
      `${action}：${change.path}？`, { modal: true }, "确认恢复"
    );
    if (confirm !== "确认恢复") return;
    await restoreWorktreeChange(cwd, change, sideValue);
    toast("info", sideValue === "working" ? `已恢复工作区文件 ${change.path}。` : `已撤销暂存 ${change.path}；工作区内容未改变。`);
    await this.refresh();
  }

  /** Deletes an untracked file only after confirmation and a fresh porcelain revalidation. */
  private async deleteUntrackedChangedFile(cwd: string, pathValue: unknown): Promise<void> {
    if (typeof pathValue !== "string") throw new Error("缺少要删除的未跟踪文件路径。 ");
    const change = (await getWorktreeChanges(cwd)).find((item) => item.path === pathValue);
    if (!change || change.staged || !change.unstaged || change.worktreeKind !== "untracked") {
      throw new Error("文件不是当前未跟踪状态；未删除文件。 ");
    }
    const confirm = await vscode.window.showWarningMessage(
      `删除未跟踪文件 ${change.path}？此操作会从磁盘永久删除，Git 不能恢复。`,
      { modal: true },
      "删除文件"
    );
    if (confirm !== "删除文件") return;
    const current = (await getWorktreeChanges(cwd)).find((item) => item.path === pathValue);
    if (!current || current.staged || !current.unstaged || current.worktreeKind !== "untracked") {
      throw new Error("文件状态已在确认期间变化；未删除文件。 ");
    }
    await deleteUntrackedWorktreeChange(cwd, current);
    toast("info", `已删除未跟踪文件 ${current.path}。`);
    await this.refresh();
  }

  /**
   * Opens an actual parent-to-commit two-sided Diff. The webview can request
   * only a currently rendered full hash; Git resolves parents/files afresh and
   * the shared opaque request store authorizes both virtual content sides.
   */
  private async openCommitDiff(cwd: string, hash: string): Promise<void> {
    let plan = this.commitDiffCache.get(`${cwd}:${hash}`);
    if (!plan) {
      const [parentsResult, namesResult, numstatResult] = await Promise.all([
        runGit(["show", "-s", "--format=%P", hash], { cwd }),
        runGit(["diff-tree", "--no-commit-id", "--name-status", "-z", "-M", "--root", "-r", hash], { cwd }),
        runGit(["diff-tree", "--no-commit-id", "--numstat", "-z", "-M", "--root", "-r", hash], { cwd }),
      ]);
      if (parentsResult.code !== 0 || namesResult.code !== 0 || numstatResult.code !== 0) {
        throw new Error(
          parentsResult.stderr || namesResult.stderr || numstatResult.stderr ||
          parentsResult.stdout || namesResult.stdout || numstatResult.stdout ||
          "无法读取 commit 文件变更。"
        );
      }
      plan = commitDiffPlan(
        hash,
        parentsResult.stdout.trim().split(/\s+/).filter(Boolean),
        applyCommitBinaryStatus(parseCommitChangedFiles(namesResult.stdout), numstatResult.stdout)
      );
      // Commit objects are immutable. Bound the lightweight selection cache;
      // virtual URI content remains independently TTL/LRU controlled.
      if (this.commitDiffCache.size >= 128) {
        const first = this.commitDiffCache.keys().next().value as string | undefined;
        if (first) this.commitDiffCache.delete(first);
      }
      this.commitDiffCache.set(`${cwd}:${hash}`, plan);
    }
    if (plan.fallbackReason) {
      toast("warn", plan.fallbackReason);
      return;
    }
    let file = plan.files[0];
    if (plan.files.length > 1) {
      const choice = await vscode.window.showQuickPick(
        plan.files.map((entry) => ({
          label: entry.path,
          description: entry.kind === "rename" && entry.originalPath ? `${entry.kind}: ${entry.originalPath} → ${entry.path}` : entry.kind,
          detail: entry.binary ? "binary — will show a safe fallback" : "parent ↔ commit",
          entry,
        })),
        { placeHolder: "选择要在 parent ↔ commit Diff 中打开的文件", matchOnDescription: true }
      );
      if (!choice) return;
      file = choice.entry;
    }
    const result = await openCommitFileDiff(this.diffRequests, cwd, plan.parent, plan.commit, file!);
    if (result.fallback) toast("warn", result.fallback);
  }

  /**
   * Generates a plain, read-only document from an exact current snapshot. Unlike
   * `vscode.diff`, its selected commits are concatenated oldest-first, but a
   * multi-commit request must still name one continuous timeline range.
   */
  private async generateCommitDiffDocument(
    cwd: string,
    hashes: readonly string[],
    revision: unknown
  ): Promise<void> {
    if (revision !== this.canonicalRevision) {
      throw new Error("Diff 选择已失效；commit 列表已刷新。 ");
    }
    const commits = generatedDiffCommits(this.commits, hashes);
    if (!commits) throw new Error("Diff 选择已失效；请刷新后重试。 ");
    const snapshot = await buildGeneratedDiffSnapshot(commits, async (commit) => {
      const result = await runGit(["show", "--binary", "--find-renames", "--format=fuller", "--no-ext-diff", commit.hash], {
        cwd,
        maxBuffer: 4_000_000,
      });
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || `无法生成 ${commit.shortHash} 的 Diff。`);
      return result.stdout;
    });
    if (!generatedDiffRequestIsCurrent(
      commits,
      this.commits,
      hashes,
      revision,
      this.canonicalRevision
    )) {
      throw new Error("Diff 生成期间 commit 列表已变化；未打开过期文档。 ");
    }
    // A private virtual-document URI is read-only. It holds this exact string
    // snapshot rather than re-running Git when the document is later opened.
    const uri = generatedDiffUri(this.generatedDiffSnapshots, cwd, snapshot.content);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
    toast("info", snapshot.truncated ? "已生成只读 Diff 文档（输出已截断）。" : "已生成只读 Diff 文档。");
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

    const confirm = await vscode.window.showWarningMessage(
      `${label}？（${refspec}）`,
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

}

/** Native workbench notifications replace webview-only inline feedback. */
function toast(level: "info" | "warn" | "error", message: string, _duration?: number): void {
  if (level === "info") {
    void vscode.window.showInformationMessage(message);
  } else if (level === "warn") {
    void vscode.window.showWarningMessage(message);
  } else {
    void vscode.window.showErrorMessage(message);
  }
}
