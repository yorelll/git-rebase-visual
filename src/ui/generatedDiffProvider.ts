import * as vscode from "vscode";
import {
  GeneratedDiffSnapshotStore,
  createGeneratedDiffSnapshotStore,
} from "./generatedDiffDocument";
import { generatedDiffScheme, generatedDiffUriComponents } from "./generatedDiffUriState";

/** Creates an opaque, extension-authorized URI for one immutable Diff snapshot. */
export function generatedDiffUri(
  store: GeneratedDiffSnapshotStore,
  repository: string,
  content: string
): vscode.Uri {
  const id = store.create({ repository, content, language: "diff" });
  return vscode.Uri.from(generatedDiffUriComponents(id));
}

/**
 * Supplies immutable generated Diff snapshots through VS Code's public virtual
 * document API. The URI never carries repository, ref, path, or Git command
 * inputs, and provider content is deliberately frozen at generation time.
 */
export class GeneratedDiffProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  constructor(private readonly snapshots: GeneratedDiffSnapshotStore = createGeneratedDiffSnapshotStore()) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    let id: string;
    try {
      id = decodeURIComponent(uri.query);
    } catch {
      return "[Git Rebase Visual: 无法解析生成 Diff 快照。]";
    }
    const snapshot = this.snapshots.resolve(id);
    return snapshot?.content ?? "[Git Rebase Visual: 此生成 Diff 快照已失效。]";
  }

  invalidateRepository(repository: string): void {
    this.snapshots.invalidateRepository(repository);
  }

  dispose(): void {
    this.snapshots.clear();
  }
}

export { generatedDiffScheme };
