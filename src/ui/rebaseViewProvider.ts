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
  repoRoot,
  fullMessage,
  commitDetail,
  workingStatus,
  isDirty,
} from "../git/commitLog";
import {
  executeRebase,
  continueRebase,
  abortRebase,
  resolveBase,
  RebaseItem,
  RebaseBase,
} from "../git/rebaseEngine";
import { git } from "../git/gitRunner";
import {
  getUpstream,
  lockedInPush,
  resolveRefspec,
  pushRefspec,
} from "../git/pushGuard";
import { splitTrailers, applyTrailers } from "../git/message";
import { stashPush, stashPop, commitIndex, commitAll } from "../git/worktree";
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
  isLlmConfigured,
} from "../config";

interface FromWebview {
  type: string;
  [k: string]: any;
}

export class RebaseViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "gitRebaseVisual.commits";

  private view?: vscode.WebviewView;
  private commits: Commit[] = [];
  private root?: string;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly locks: LockStore
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
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

  public async refresh(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
      return this.post({ type: "state", error: "No workspace folder open." });
    }
    const root = await repoRoot(folder);
    if (!root) {
      return this.post({ type: "state", error: "Not a git repository." });
    }
    this.root = root;

    const rebaseInProgress = await isRebaseInProgress(root);

    // During a rebase HEAD is detached; resolve the range against the branch
    // being rebased so we still show meaningful commits instead of "no upstream".
    const tipRef = rebaseInProgress ? await rebasingBranch(root) : undefined;
    const range = await resolveRange(root, getRangeConfig(), tipRef ?? "HEAD");
    if ("error" in range) {
      return this.post({ type: "state", error: range.error, rebaseInProgress });
    }

    try {
      this.commits = await getCommits(root, range.revRange);
    } catch (e: any) {
      return this.post({ type: "state", error: String(e.message ?? e), rebaseInProgress });
    }

    const stoppedAt = rebaseInProgress ? await rebaseStoppedSha(root) : undefined;

    // Determine locked state per commit. Only compute patch-ids when locks
    // exist (patch-id computation costs two git calls per commit).
    const hasLocks = this.locks.hasLocks(root);
    const lockedHashes = this.locks.lockedHashes(root);
    const lockedPatchIds = this.locks.lockedPatchIds(root);
    const lockedFlags = new Map<string, boolean>();
    for (const c of this.commits) {
      let isLocked = lockedHashes.has(c.hash);
      if (!isLocked && hasLocks && lockedPatchIds.size > 0) {
        const pid = await this.locks.computePatchId(root, c.hash);
        isLocked = !!pid && lockedPatchIds.has(pid);
      }
      lockedFlags.set(c.hash, isLocked);
    }

    const status = await workingStatus(root);

    // Send oldest-first (root at top, newest at bottom) for a natural timeline.
    const ordered = [...this.commits].reverse();
    this.post({
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
    const cwd = this.cwd();
    if (!cwd && m.type !== "ready") {
      return;
    }
    // While a rebase is paused, only allow read/continue/abort/copy actions.
    const mutating = ["reorder", "drop", "rebaseTo", "apply", "rebaseAndPush"];
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
          vscode.window.showInformationMessage(`已复制 ${m.hash}`);
          break;
        case "copyText":
          await vscode.env.clipboard.writeText(m.text ?? "");
          vscode.window.showInformationMessage("已复制到剪贴板");
          break;
        case "requestDetail":
          await this.sendDetail(cwd!, m.hash);
          break;
        case "reorder":
          await this.handleReorder(cwd!, m.order as string[]);
          break;
        case "drop": {
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
        case "generate":
          await this.generate(cwd!, m.mode, m.hash, m.extra ?? "");
          break;
        case "apply":
          await this.apply(cwd!, m.mode, m.hash, m.message, m.thenEdit === true);
          break;
        case "rebaseAndPush":
          await this.rebaseAndPush(cwd!, m.hash);
          break;
        case "continueRebase": {
          const r = await continueRebase(cwd!);
          if (!r.ok && !r.stopped) {
            vscode.window.showErrorMessage(r.message);
          }
          await this.refresh();
          break;
        }
        case "abortRebase":
          await abortRebase(cwd!);
          await this.refresh();
          break;
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(String(e.message ?? e));
      await this.refresh();
    }
  }

  private async handleReorder(cwd: string, displayOrder: string[]): Promise<void> {
    // displayOrder is oldest-first (top->bottom), which is already todo order.
    const bySubject = new Map(this.commits.map((c) => [c.hash, c.subject]));
    const items: RebaseItem[] = displayOrder.map((hash) => ({
      hash,
      action: "pick",
      subject: bySubject.get(hash) ?? "",
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

  private async runRebase(
    cwd: string,
    plan: { items: RebaseItem[]; newMessage?: string; onto?: RebaseBase }
  ): Promise<void> {
    // Auto-stash a dirty worktree so the rebase can start on a clean tree.
    const stashed = (await isDirty(cwd)) ? await stashPush(cwd) : false;

    const onto = plan.onto ?? (await this.computeBase(cwd));
    const outcome = await executeRebase(cwd, { ...plan, onto });

    if (!outcome.ok && !outcome.stopped) {
      vscode.window.showErrorMessage(`变基失败：${outcome.message}`);
    } else if (outcome.stopped) {
      vscode.window.showWarningMessage(
        "变基已暂停（冲突或 edit 停靠）。请解决后在面板 Continue 或 Abort。"
      );
    }

    // Only pop when the rebase fully finished; a paused rebase can't take the
    // stash back yet (tell the user so they can pop manually).
    if (stashed) {
      if (outcome.ok && !outcome.stopped) {
        const pop = await stashPop(cwd);
        if (!pop.ok) {
          vscode.window.showWarningMessage(
            `已自动 stash 你的改动，但恢复时有冲突：${pop.message}。请手动 git stash pop。`
          );
        }
      } else {
        vscode.window.showWarningMessage(
          "你的未提交改动已被自动 stash。完成/取消变基后请执行 git stash pop 恢复。"
        );
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
      vscode.window.showErrorMessage(
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
      vscode.window.showErrorMessage("请先配置 LLM。");
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
          const opts = { ...getLlmExtras(), extraInfo: extra };
          if (mode === "commit" && hash) {
            text = await generateMessage(cwd, hash, getLlmConfig(), opts, ctrl.signal);
          } else {
            const diff =
              mode === "staged"
                ? await getStagedDiff(cwd)
                : await getWorkingDiff(cwd);
            if (!diff.trim()) {
              vscode.window.showWarningMessage("没有可用于生成的改动。");
              return;
            }
            text = await generateFromDiff(diff, getLlmConfig(), opts, ctrl.signal);
          }
          this.post({ type: "genResult", text: text || "" });
        } catch (e: any) {
          if (ctrl.signal.aborted) {
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
      vscode.window.showInformationMessage("已用生成的 message 提交暂存区改动。");
    } else if (mode === "working") {
      await commitAll(cwd, message.replace(/\s+$/, "") + "\n");
      vscode.window.showInformationMessage("已暂存并提交工作区改动。");
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

  private async rebaseAndPush(cwd: string, hash: string): Promise<void> {
    const up = await getUpstream(cwd);
    if (!up) {
      vscode.window.showErrorMessage("当前分支未配置 upstream。");
      return;
    }
    const blocked = await lockedInPush(
      cwd,
      hash,
      this.locks.lockedHashes(this.root!),
      this.locks.lockedPatchIds(this.root!)
    );
    if (blocked.length > 0) {
      const short = blocked.map((h) => h.slice(0, 7)).join(", ");
      vscode.window.showErrorMessage(
        `推送被拒绝：推送范围包含被锁定的 commit（${short}）。请将此 commit 移到锁定 commit 之前再推送。`
      );
      return;
    }

    // Decide the refspec: normal branch push, or a configured review push.
    const template = getPushRefspecTemplate();
    let refspec = resolveRefspec(up, hash, "");
    let label = `普通推送到 ${up.ref}`;
    if (template.trim()) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: "普通推送", detail: `${hash.slice(0, 7)} → refs/heads/${up.branch}`, kind: "normal" },
          { label: "评审推送", detail: resolveRefspec(up, hash, template), kind: "review" },
          { label: "自定义 refspec…", detail: "手动输入", kind: "custom" },
        ] as any,
        { placeHolder: "选择推送方式" }
      );
      if (!choice) {
        return;
      }
      if ((choice as any).kind === "review") {
        refspec = resolveRefspec(up, hash, template);
        label = `评审推送 (${refspec})`;
      } else if ((choice as any).kind === "custom") {
        const input = await vscode.window.showInputBox({
          prompt: "输入 refspec（可用 ${tip} / ${branch} 占位符）",
          value: template,
        });
        if (!input) {
          return;
        }
        refspec = resolveRefspec(up, hash, input);
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
    await pushRefspec(cwd, up, refspec);
    vscode.window.showInformationMessage(`已推送：${refspec} → ${up.remote}`);
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

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
