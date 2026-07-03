import * as vscode from "vscode";
import { RebaseViewProvider } from "./ui/rebaseViewProvider";
import { LockStore } from "./lock/lockStore";

export function activate(context: vscode.ExtensionContext): void {
  const locks = new LockStore(context.globalState);
  const provider = new RebaseViewProvider(context, locks);

  context.subscriptions.push(
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
    )
  );
}

export function deactivate(): void {
  // nothing to clean up
}
