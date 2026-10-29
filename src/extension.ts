import * as vscode from "vscode";
import { RebaseViewProvider } from "./ui/rebaseViewProvider";
import { LockStore } from "./lock/lockStore";
import { GitContentProvider, gitContentScheme } from "./ui/worktreeDiff";
import { createGitContentRequestStore } from "./ui/gitDiffRequestState";
import { createGeneratedDiffSnapshotStore } from "./ui/generatedDiffDocument";
import { GeneratedDiffProvider, generatedDiffScheme } from "./ui/generatedDiffProvider";
import { setGitInvocationObserver } from "./git/gitRunner";
import { FileLogger, legacyLogRoot, logDirectory } from "./diagnostics/fileLogger";
import { setDiagnosticsLogger, warnDiagnostic } from "./diagnostics/diagnostics";

/** The log-location note is said once per extension-host session, not per click. */
let legacyLogHintShown = false;

export function activate(context: vscode.ExtensionContext): void {
  const version = String(context.extension?.packageJSON?.version ?? "0.0.0");
  const extensionPath = context.extension?.extensionPath ?? context.extensionUri?.fsPath ?? "unknown";
  const logger = new FileLogger({ directory: logDirectory(version) });
  // Identify the exact build. Several VSIX versions can live in the repo root,
  // and "it still reports 0.7.1" is usually the wrong VSIX being installed, so
  // version, path and host pid are recorded before anything else runs.
  logger.start([
    `version=${version}`,
    `extensionPath=${extensionPath}`,
    `vscode=${vscode.version}`,
    `platform=${process.platform}-${process.arch}`,
    `pid=${process.pid}`,
  ]);
  setDiagnosticsLogger(logger);
  // Every Git invocation is recorded with argv, exit code and duration. The
  // observer is best-effort: it must never influence command execution.
  setGitInvocationObserver((entry) => {
    const outcome = entry.timedOut ? " timedOut" : entry.cancelled ? " cancelled" : "";
    // Non-zero exits are normal (rev-parse probes, expected failures); the code
    // is always recorded so they stay visible without inflating severity.
    logger.info(
      "git",
      `git ${entry.args.join(" ")} cwd=${entry.cwd} code=${entry.code} durationMs=${entry.durationMs}${outcome}`
    );
  });

  const locks = new LockStore(context.globalState);
  const diffRequests = createGitContentRequestStore();
  const generatedDiffSnapshots = createGeneratedDiffSnapshotStore();
  const provider = new RebaseViewProvider(context, locks, diffRequests, generatedDiffSnapshots);
  const contentProvider = new GitContentProvider(diffRequests);
  const generatedDiffProvider = new GeneratedDiffProvider(generatedDiffSnapshots);

  context.subscriptions.push(
    contentProvider,
    generatedDiffProvider,
    vscode.workspace.registerTextDocumentContentProvider(gitContentScheme, contentProvider),
    vscode.workspace.registerTextDocumentContentProvider(generatedDiffScheme, generatedDiffProvider),
    vscode.window.registerWebviewViewProvider(
      RebaseViewProvider.viewType,
      provider
    ),
    vscode.commands.registerCommand("gitRebaseVisual.refresh", () =>
      provider.refreshFromCommand()
    ),
    vscode.commands.registerCommand("gitRebaseVisual.push", () =>
      provider.pushBranch()
    ),
    vscode.commands.registerCommand("gitRebaseVisual.stash", () =>
      provider.stashChanges()
    ),
    vscode.commands.registerCommand("gitRebaseVisual.stashPop", () =>
      provider.popChanges()
    ),
    vscode.commands.registerCommand("gitRebaseVisual.stashList", () =>
      provider.showStashList()
    ),
    vscode.commands.registerCommand("gitRebaseVisual.undo", () =>
      provider.undoLastRewrite()
    ),
    vscode.commands.registerCommand("gitRebaseVisual.reveal", () =>
      vscode.commands.executeCommand("workbench.view.extension.gitRebaseVisual")
    ),
    vscode.commands.registerCommand("gitRebaseVisual.openLogs", async () => {
      // 0.8.0 and earlier wrote to the OS temp directory. Say so once per
      // session: those files are still on disk, but they will never be pruned
      // or rotated again, so a user attaching logs should know both places. The
      // note names the legacy *root*: old folders there are suffixed with the
      // version that wrote them, so no 0.8.1 folder exists under it.
      if (!legacyLogHintShown) {
        legacyLogHintShown = true;
        provider.noteLogLocation(
          `日志目录自 0.8.1 起位于 ${logDirectory(version)}；0.8.1 之前的日志在 ${legacyLogRoot()} 下（按当时的版本分子目录），旧文件仍保留在那里。`
        );
      }
      // The folder is created lazily, so make sure it exists before revealing.
      const folder = logger.ensureDirectory();
      const uri = vscode.Uri.file(folder);
      try {
        await vscode.commands.executeCommand("revealFileInOS", uri);
      } catch {
        // `revealFileInOS` needs a file on some hosts; fall back to the folder.
        try {
          await vscode.env.openExternal(uri);
        } catch {
          warnDiagnostic("logs", `无法打开日志目录 ${folder}`);
        }
      }
      void vscode.window.showInformationMessage(`Git Rebase Visual 日志：${folder}`);
    }),
    vscode.commands.registerCommand("gitRebaseVisual.forceReleaseMutation", () =>
      provider.forceReleaseMutationLock()
    ),
    vscode.commands.registerCommand("gitRebaseVisual.resetState", () =>
      provider.resetExtensionState()
    ),
    new vscode.Disposable(() => {
      setGitInvocationObserver(undefined);
      setDiagnosticsLogger(undefined);
    })
  );
}

export function deactivate(): void {
  // Every disposable is registered on the extension context.
}
