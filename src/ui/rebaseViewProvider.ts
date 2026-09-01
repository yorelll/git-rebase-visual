import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
  Commit,
  getCommits,
  resolveRange,
  isRebaseInProgress,
  rebaseStoppedSha,
  rebasingBranch,
  currentBranch,
  repoRoot,
  fullMessage,
  commitDetail,
  workingStatus,
  isDirty,
  conflictedFiles,
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
  isLlmConfigured,
} from "../config";

const PENDING_STASH_KEY = "gitRebaseVisual.pendingStash";
const PENDING_APPEND_KEY = "gitRebaseVisual.pendingAppend";

interface PendingAppend {
  changeStash: string;
  unstagedStash?: string;
  /** Original target SHA; distinguishes an external abort from a completed replay. */
  targetHash?: string;
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
  private refreshTimer?: NodeJS.Timeout;
  private statusPoller?: NodeJS.Timeout;
  private statusPollerStarted = false;
  private readonly output: vscode.OutputChannel;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly locks: LockStore
  ) {
    this.output = vscode.window.createOutputChannel("Git Rebase Visual");
    ctx.subscriptions.push(this.output);
    ctx.subscriptions.push(
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
      await this.restorePendingAppend(root, root, !targetRewritten);
    }
    if (!isCurrent()) {
      return;
    }

    // During a rebase HEAD is detached; resolve the range against the branch
    // being rebased so we still show meaningful commits instead of "no upstream".
    const tipRef = rebaseInProgress ? await rebasingBranch(root) : undefined;
    const range = await resolveRange(root, getRangeConfig(), tipRef ?? "HEAD");
    if ("error" in range) {
      return postCurrent({ type: "state", error: range.error, rebaseInProgress });
    }

    let commits: Commit[];
    try {
      commits = await getCommits(root, range.revRange);
    } catch (e: any) {
      return postCurrent({ type: "state", error: String(e.message ?? e), rebaseInProgress });
    }

    const stoppedAt = rebaseInProgress ? await rebaseStoppedSha(root) : undefined;

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

    // Send oldest-first (root at top, newest at bottom) for a natural timeline.
    const ordered = [...commits].reverse();
    postCurrent({
      type: "state",
      rebaseInProgress,
      stoppedAt,
      llmConfigured: isLlmConfigured(),
      hasStaged: status.hasStaged,
      hasUnstaged: status.hasUnstaged,
      commits: ordered.map((c) => ({
        hash: c.hash,
        shortHash: c.shortHash,
        subject: c.subject,
        author: c.author,
        date: c.date,
        locked: lockedFlags.get(c.hash) ?? false,
      })),
    });
  }

  private post(msg: any): void {
    this.view?.webview.postMessage(msg);
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
      "rebaseTo",
      "lock",
      "unlock",
      "openCompose",
      "generate",
      "apply",
      "appendStaged",
      "continueRebase",
      "abortRebase",
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
      "requestDetail",
      "drop",
      "rebaseTo",
      "lock",
      "unlock",
      "appendStaged",
    ]);
    const requiresCurrentCommit =
      hashActions.has(m.type) ||
      ((m.type === "openCompose" || m.type === "apply") && m.mode === "commit");
    if (requiresCurrentCommit && !this.isCurrentCommitHash(m.hash)) {
      toast("warn", "commit 列表已更新，请刷新后重试。");
      await this.refresh();
      return;
    }
    if (!cwd && m.type !== "ready") {
      return;
    }
    // While a rebase is paused, only allow read/continue/abort/copy actions.
    const mutating = ["reorder", "drop", "rebaseTo", "apply", "appendStaged"];
    if (cwd && mutating.includes(m.type) && (await isRebaseInProgress(cwd))) {
      vscode.window.showWarningMessage(
        "变基进行中，请先在面板顶部 Continue 或 Abort。"
      );
      return;
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
        case "copyText":
          await vscode.env.clipboard.writeText(m.text ?? "");
          toast("info", "已复制到剪贴板");
          break;
        case "requestDetail":
          await this.sendDetail(cwd!, m.hash);
          break;
        case "reorder":
          await this.handleReorder(cwd!, m.order as string[]);
          break;
        case "drop": {
          const commit = this.commits.find((c) => c.hash === m.hash)!;
          const confirm = await vscode.window.showWarningMessage(
            `删除 ${commit.shortHash} “${commit.subject}”？此操作会改写其后的提交历史。`,
            { modal: true },
            "删除"
          );
          if (confirm !== "删除") {
            return;
          }
          const pid = await this.locks.computePatchId(cwd!, m.hash);
          await this.runRebase(cwd!, {
            items: this.itemsWith((h) => (h === m.hash ? "drop" : undefined)),
          });
          await this.locks.unlock(this.root!, m.hash, pid);
          await this.refresh();
          break;
        }
        case "rebaseTo":
          await this.runRebase(cwd!, {
            items: this.itemsWith((h) => (h === m.hash ? "edit" : undefined)),
          });
          await this.refresh();
          break;
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
        case "openCompose":
          await this.openCompose(cwd!, m.mode, m.hash, m.thenEdit === true, m.ai === true);
          break;
        case "appendStaged":
          await this.appendStagedToCommit(cwd!, m.hash);
          break;
        case "generate":
          await this.generate(cwd!, m.mode, m.hash, m.extra ?? "");
          break;
        case "apply":
          await this.apply(cwd!, m.mode, m.hash, m.message, m.thenEdit === true);
          break;
        case "continueRebase": {
          const r = await continueRebase(cwd!);
          if (!r.ok && !r.stopped) {
            toast("error", r.message);
          }
          // Restore the auto-stash once the rebase is fully done.
          if (!(await isRebaseInProgress(cwd!))) {
            await this.popPendingStash(cwd!, this.root!);
            await this.restorePendingAppend(cwd!, this.root!);
          }
          await this.refresh();
          break;
        }
        case "abortRebase":
          await abortRebase(cwd!);
          await this.popPendingStash(cwd!, this.root!);
          await this.restorePendingAppend(cwd!, this.root!, true);
          await this.refresh();
          break;
      }
    } catch (e: any) {
      const message = String(e.message ?? e);
      this.log(m.type, `失败 ${message}`);
      toast("error", message);
      await this.refresh();
    }
  }

  private async handleReorder(cwd: string, displayOrder: unknown): Promise<void> {
    // displayOrder is oldest-first (top->bottom), which is already todo order.
    const expected = new Set(this.commits.map((c) => c.hash));
    const valid =
      Array.isArray(displayOrder) &&
      displayOrder.length === expected.size &&
      new Set(displayOrder).size === expected.size &&
      displayOrder.every(
        (hash) => typeof hash === "string" && /^[0-9a-f]{40}$/i.test(hash) && expected.has(hash)
      );
    if (!valid) {
      toast("warn", "commit 列表已更新，已取消重排。请刷新后重试。");
      await this.refresh();
      return;
    }
    const bySubject = new Map(this.commits.map((c) => [c.hash, c.subject]));
    const items: RebaseItem[] = displayOrder.map((hash) => ({
      hash,
      action: "pick",
      subject: bySubject.get(hash)!,
    }));
    await this.runRebase(cwd, { items });
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
      toast(
        "warn",
        `恢复自动 stash 时有冲突：${res.message}。stash 仍保留，请手动解决后 git stash pop。`
      );
    } else {
      toast("info", "已恢复自动 stash 的改动。");
    }
  }

  /** Restores stashes recorded while appending staged changes to a commit. */
  private async restorePendingAppend(
    cwd: string,
    root: string,
    restoreOriginalIndex = false
  ): Promise<void> {
    const pending = this.getPendingAppend(root);
    if (!pending) {
      return;
    }
    if (restoreOriginalIndex) {
      const restore = await stashApplyIndexBySha(cwd, pending.changeStash);
      if (!restore.gone && !restore.ok) {
        toast("warn", `恢复原始暂存区时有冲突：${restore.message}。stash 仍保留，请手动恢复。`);
        return;
      }
    }
    if (pending.unstagedStash) {
      const restore = await stashPopBySha(cwd, pending.unstagedStash);
      if (!restore.gone && !restore.ok) {
        toast("warn", `恢复未暂存改动时有冲突：${restore.message}。stash 仍保留，请手动恢复。`);
        return;
      }
    }
    await stashDropBySha(cwd, pending.changeStash);
    await this.clearPendingAppend(root);
  }

  /** Restores the original snapshot when setup failed before a pending record. */
  private async restoreAppendSnapshot(cwd: string, sha: string): Promise<void> {
    const restore = await stashApplyIndexBySha(cwd, sha);
    if (!restore.gone && !restore.ok) {
      toast("warn", `恢复原始改动时有冲突：${restore.message}。stash 仍保留，请手动恢复。`);
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
    const sha = await stashPush(cwd);
    if (sha) {
      await this.setPendingStash(root, sha);
    }
    return { proceed: true, stashed: !!sha };
  }

  private async runRebase(
    cwd: string,
    plan: { items: RebaseItem[]; newMessage?: string; onto?: RebaseBase }
  ): Promise<void> {
    const root = this.root!;
    const prep = await this.prepareCleanTree(cwd, root);
    if (!prep.proceed) {
      return;
    }

    const onto = plan.onto ?? (await this.computeBase(cwd));
    const outcome = await executeRebase(cwd, { ...plan, onto });

    if (!outcome.ok && !outcome.stopped) {
      this.log("rebase", `失败 ${outcome.message}`);
      toast("error", `变基失败：${outcome.message}`);
      // Rebase did not apply; restore the stash immediately (silent if none).
      if (prep.stashed) {
        await this.popPendingStash(cwd, root);
      }
    } else if (outcome.stopped) {
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
    } else if (prep.stashed) {
      // Completed cleanly — restore now.
      await this.popPendingStash(cwd, root);
    }
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

    const upstream = await runGit(["rev-parse", "--verify", "--quiet", "@{upstream}"], { cwd });
    const alreadyPushed =
      upstream.code === 0 &&
      (await runGit(["merge-base", "--is-ancestor", hash, "@{upstream}"], { cwd })).code === 0;
    const pushedWarning = alreadyPushed
      ? "该 commit 已推送到 upstream，完成后需要使用 --force-with-lease 更新远端。"
      : "";
    const confirm = await vscode.window.showWarningMessage(
      `将暂存区文件追加到 ${commit.shortHash} “${commit.subject}”？这会改写该 commit 及其后的历史。${pushedWarning}`,
      { modal: true },
      "追加"
    );
    if (confirm !== "追加") {
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
    try {
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

      // The amend consumed the index. If the user also had worktree-only
      // changes, move only those aside before Git replays following commits.
      const unstagedStash = status.hasUnstaged
        ? await stashPushKeepIndex(cwd)
        : undefined;
      await this.setPendingAppend(this.root!, { changeStash, unstagedStash, targetHash: hash });
      const continued = await continueRebase(cwd);
      if (!continued.ok) {
        throw new Error(continued.message || "继续变基失败。");
      }
      await this.restorePendingAppend(cwd, this.root!);
      toast("info", `已将暂存区文件追加到 ${commit.shortHash}。`);
    } catch (e) {
      const inProgress = await isRebaseInProgress(cwd);
      if (inProgress) {
        // Preserve the paused rebase so the user can resolve a replay conflict
        // with the existing Continue / Abort controls.
        if (!restoredForAmend) {
          toast("warn", "追加已暂停；请解决冲突后 Continue 或 Abort。原始改动仍保存在 stash 中。");
        }
      } else if (!restoredForAmend) {
        await this.restoreAppendSnapshot(cwd, changeStash);
      }
      throw e;
    } finally {
      if (!(await isRebaseInProgress(cwd))) {
        await this.refresh();
      }
    }
  }

  /** Opens the compose dialog for a reword / AI / staged / working message. */
  private async openCompose(
    cwd: string,
    mode: string,
    hash: string | undefined,
    thenEdit: boolean,
    ai: boolean
  ): Promise<void> {
    if (ai && !isLlmConfigured()) {
      toast("error", 
        "请先在设置中配置 gitRebaseVisual.llm.baseUrl 与 apiKey。"
      );
      return;
    }
    let body = "";
    let trailers = "";
    if (mode === "commit" && hash) {
      const original = await fullMessage(cwd, hash);
      const split = splitTrailers(original);
      body = split.body;
      trailers = split.trailers;
    }
    this.post({
      type: "openCompose",
      mode,
      hash,
      thenEdit,
      ai,
      original: body, // original header/body for comparison
      trailers, // preserved, shown read-only
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
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "AI 生成 commit message 中…",
        cancellable: true,
      },
      async (_p, token) => {
        const ctrl = new AbortController();
        token.onCancellationRequested(() => ctrl.abort());
        try {
          let text: string;
          const { timeout, ...extras } = getLlmExtras();
          const opts = { ...extras, extraInfo: extra };
          const onDelta = (chunk: string) => this.post({ type: "genDelta", text: chunk });
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
              this.post({ type: "genCancelled" });
              return;
            }
            text = await generateFromDiff(diff, getLlmConfig(), opts, onDelta, requestOptions);
          }
          this.post({ type: "genResult", text: text || "" });
        } catch (e: any) {
          if (ctrl.signal.aborted) {
            // User cancelled — reset the dialog's generate button.
            this.post({ type: "genCancelled" });
            return;
          }
          this.post({ type: "genError", message: String(e.message ?? e) });
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
    thenEdit: boolean
  ): Promise<void> {
    if (!message.trim()) {
      return;
    }
    if (mode === "commit" && hash) {
      // Preserve Change-Id / Signed-off-by trailers from the original message.
      const original = await fullMessage(cwd, hash);
      const finalMsg = applyTrailers(message, original);
      if (thenEdit) {
        await this.runRebase(cwd, {
          items: this.itemsWith((h) => (h === hash ? "edit" : undefined)),
        });
        if (await isRebaseInProgress(cwd)) {
          await git(["commit", "--amend", "-m", finalMsg], { cwd });
        }
      } else {
        await this.runRebase(cwd, {
          items: this.itemsWith((h) => (h === hash ? "reword" : undefined)),
          newMessage: finalMsg,
        });
      }
    } else if (mode === "staged") {
      await commitIndex(cwd, message.replace(/\s+$/, "") + "\n");
      toast("info", "已用生成的 message 提交暂存区改动。");
    } else if (mode === "working") {
      await commitAll(cwd, message.replace(/\s+$/, "") + "\n");
      toast("info", "已暂存并提交工作区改动。");
    }
    await this.refresh();
  }

  private async sendDetail(cwd: string, hash: string): Promise<void> {
    try {
      const d = await commitDetail(cwd, hash);
      this.post({ type: "detail", hash, ...d });
    } catch {
      // ignore hover detail failures
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
    const sha = await stashPush(cwd);
    if (sha) {
      toast("info", "已 stash 未提交的改动。");
    }
    await this.refresh();
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
        location: vscode.ProgressLocation.Notification,
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
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>Git Rebase</title>
</head>
<body>
<div id="banner" class="banner hidden"></div>
<div id="changes" class="changes hidden"></div>
<div id="list" class="list"></div>
<div id="menu" class="menu hidden"></div>
<div id="tooltip" class="tooltip hidden"></div>
<div id="dialog" class="dialog-backdrop hidden">
  <div class="dialog">
    <div class="dialog-title" id="dialog-title">编辑 commit message</div>

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
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/**
 * Shows a non-modal notification that auto-dismisses after `ms` (default 10s).
 * VSCode keeps warning/error toasts open until dismissed, so we render them as
 * a progress notification with a codicon prefix and resolve on a timer — this
 * gives consistent auto-dismissal for all plugin messages. Fire-and-forget.
 */
function toast(level: "info" | "warn" | "error", message: string, ms = 10000): void {
  // Progress-notification titles do not parse `$(codicon)` syntax, so use plain
  // Unicode glyphs for the severity prefix.
  const icon = level === "error" ? "✕" : level === "warn" ? "⚠" : "✓";
  void vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `${icon} ${message}`,
      cancellable: true,
    },
    () => new Promise<void>((resolve) => setTimeout(resolve, ms))
  );
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
