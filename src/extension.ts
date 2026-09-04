import * as vscode from "vscode";
import { RebaseViewProvider } from "./ui/rebaseViewProvider";
import { LockStore } from "./lock/lockStore";
import { SecretsAccessModule, fromSecretStorage } from "./ui/secretsAccess";

export function activate(context: vscode.ExtensionContext): void {
  const locks = new LockStore(context.globalState);
  // Expose the extension-host SecretStorage to the provider's capability hints
  // (the API-key migration reads through this accessor).
  SecretsAccessModule.set(fromSecretStorage(context.secrets));
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
    ),
    vscode.commands.registerCommand("gitRebaseVisual.stashList", () =>
      provider.showStashList()
    )
  );
}

export function deactivate(): void {
  // nothing to clean up
}
