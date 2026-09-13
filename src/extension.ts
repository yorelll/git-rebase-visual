import * as vscode from "vscode";
import { RebaseViewProvider } from "./ui/rebaseViewProvider";
import { LockStore } from "./lock/lockStore";
import { GitContentProvider, gitContentScheme } from "./ui/worktreeDiff";
import { createGitContentRequestStore } from "./ui/gitDiffRequestState";
import { createGeneratedDiffSnapshotStore } from "./ui/generatedDiffDocument";
import { GeneratedDiffProvider, generatedDiffScheme } from "./ui/generatedDiffProvider";

export function activate(context: vscode.ExtensionContext): void {
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
      provider.refresh()
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
    )
  );
}

export function deactivate(): void {
  // nothing to clean up
}
