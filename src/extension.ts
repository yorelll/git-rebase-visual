import * as vscode from "vscode";
import { RebaseViewProvider } from "./ui/rebaseViewProvider";
import { LockStore } from "./lock/lockStore";
import { SecretsAccessModule, fromSecretStorage } from "./ui/secretsAccess";
import { GitContentProvider, gitContentScheme } from "./ui/worktreeDiff";
import { createGitContentRequestStore } from "./ui/gitDiffRequestState";

export function activate(context: vscode.ExtensionContext): void {
  const locks = new LockStore(context.globalState);
  // Expose the extension-host SecretStorage to the provider's capability hints
  // (the API-key migration reads through this accessor).
  SecretsAccessModule.set(fromSecretStorage(context.secrets));
  const diffRequests = createGitContentRequestStore();
  const provider = new RebaseViewProvider(context, locks, diffRequests);
  const contentProvider = new GitContentProvider(diffRequests);

  context.subscriptions.push(
    contentProvider,
    vscode.workspace.registerTextDocumentContentProvider(gitContentScheme, contentProvider),
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
