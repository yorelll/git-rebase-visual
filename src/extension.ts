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
    vscode.commands.registerCommand("gitRebaseVisual.commit.copyHash", (element) => provider.nativeCommand("copyHash", element)),
    vscode.commands.registerCommand("gitRebaseVisual.commit.copyMessage", (element) => provider.nativeCommand("copyMessage", element)),
    vscode.commands.registerCommand("gitRebaseVisual.commit.openDiff", (element) => provider.nativeCommand("openDiff", element)),
    vscode.commands.registerCommand("gitRebaseVisual.commit.generateDiff", (element) => provider.nativeCommand("generateDiff", element)),
    vscode.commands.registerCommand("gitRebaseVisual.commit.reword", (element) => provider.nativeCommand("reword", element)),
    vscode.commands.registerCommand("gitRebaseVisual.commit.aiMessage", (element) => provider.nativeCommand("aiMessage", element)),
    vscode.commands.registerCommand("gitRebaseVisual.commit.rebaseTo", (element) => provider.nativeCommand("rebaseTo", element)),
    vscode.commands.registerCommand("gitRebaseVisual.commit.appendStaged", (element) => provider.nativeCommand("appendStaged", element)),
    vscode.commands.registerCommand("gitRebaseVisual.commit.lock", (element) => provider.nativeCommand("lock", element)),
    vscode.commands.registerCommand("gitRebaseVisual.commit.unlock", (element) => provider.nativeCommand("unlock", element)),
    vscode.commands.registerCommand("gitRebaseVisual.commit.drop", (element) => provider.nativeCommand("drop", element)),
    vscode.commands.registerCommand("gitRebaseVisual.commit.squash", (element) => provider.nativeCommand("squash", element)),
    vscode.commands.registerCommand("gitRebaseVisual.commit.fixup", (element) => provider.nativeCommand("fixup", element)),
    vscode.commands.registerCommand("gitRebaseVisual.commit.bulkLock", (element) => provider.nativeCommand("bulkLock", element)),
    vscode.commands.registerCommand("gitRebaseVisual.commit.bulkDrop", (element) => provider.nativeCommand("bulkDrop", element)),
    vscode.commands.registerCommand("gitRebaseVisual.commit.bulkGenerateDiff", (element) => provider.nativeCommand("bulkGenerateDiff", element)),
    vscode.commands.registerCommand("gitRebaseVisual.worktree.openDiff", (element) => provider.nativeCommand("openWorktreeDiff", element)),
    vscode.commands.registerCommand("gitRebaseVisual.worktree.stage", (element) => provider.nativeCommand("stageFile", element)),
    vscode.commands.registerCommand("gitRebaseVisual.worktree.restore", (element) => provider.nativeCommand("restoreFile", element)),
    vscode.commands.registerCommand("gitRebaseVisual.worktree.deleteUntracked", (element) => provider.nativeCommand("deleteUntrackedFile", element)),
    vscode.commands.registerCommand("gitRebaseVisual.worktree.stageAll", (element) => provider.nativeCommand("stageAllFiles", element)),
    vscode.commands.registerCommand("gitRebaseVisual.worktree.discardAll", (element) => provider.nativeCommand("discardAllFiles", element)),
    vscode.commands.registerCommand("gitRebaseVisual.worktree.unstageAll", (element) => provider.nativeCommand("unstageAllFiles", element)),
    vscode.commands.registerCommand("gitRebaseVisual.worktree.stagedAiMessage", (element) => provider.nativeCommand("stagedAiMessage", element)),
    vscode.commands.registerCommand("gitRebaseVisual.rebase.continue", (element) => provider.nativeCommand("continueRebase", element)),
    vscode.commands.registerCommand("gitRebaseVisual.rebase.abort", (element) => provider.nativeCommand("abortRebase", element)),
    vscode.commands.registerCommand("gitRebaseVisual.rebase.skip", (element) => provider.nativeCommand("skipRebase", element)),
    vscode.commands.registerCommand("gitRebaseVisual.rebase.editStopAmend", (element) => provider.nativeCommand("editStopAmend", element)),
    vscode.commands.registerCommand("gitRebaseVisual.rebase.editStopNew", (element) => provider.nativeCommand("editStopNew", element)),
    vscode.commands.registerCommand("gitRebaseVisual.rebase.editStopDraft", (element) => provider.nativeCommand("editStopDraft", element)),
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
    )
  );
  provider.start();
}

export function deactivate(): void {
  // nothing to clean up
}
