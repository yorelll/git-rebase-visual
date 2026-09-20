import * as vscode from "vscode";
import { Commit, CommitDetail } from "../git/commitLog";
import { WorktreeChange } from "../git/worktreeChanges";

export const nativeCommitTreeViewId = "gitRebaseVisual.commits";
export const nativeCommitTreeMime = "application/vnd.code.tree.gitrebasevisual.commits";

export type NativeCommitTreeElement =
  | NativeCommitTreeCommit
  | NativeCommitTreeWorktreeChange
  | NativeCommitTreeMessage;

export interface NativeCommitTreeCommit {
  readonly kind: "commit";
  readonly commit: Commit;
  readonly locked: boolean;
  readonly stopped: boolean;
  readonly pending: boolean;
  readonly detail?: CommitDetail;
}

export interface NativeCommitTreeWorktreeChange {
  readonly kind: "worktree";
  readonly change: WorktreeChange;
  readonly side: "staged" | "working";
}

export interface NativeCommitTreeMessage {
  readonly kind: "message";
  readonly label: string;
  readonly tooltip?: string;
}

function commitTooltip(commit: Commit, detail?: CommitDetail): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**${commit.subject || "(no subject)"}**\n\n`);
  tooltip.appendMarkdown(`\`${commit.hash}\`\n\n`);
  tooltip.appendMarkdown(`Author: ${detail?.author ?? commit.author} <${detail?.email ?? commit.authorEmail}>\n\n`);
  tooltip.appendMarkdown(`Date: ${detail?.absDate ?? commit.date}${detail?.relDate ? ` (${detail.relDate})` : ""}`);
  if (detail?.stat) tooltip.appendMarkdown(`\n\n${detail.stat}`);
  if (detail?.message) tooltip.appendMarkdown(`\n\n---\n\n${detail.message.trim()}`);
  return tooltip;
}

function worktreeLabel(change: WorktreeChange, side: "staged" | "working"): string {
  const kind = side === "staged" ? change.indexKind : change.worktreeKind;
  const prefix = kind === "untracked" ? "U" : kind === "add" ? "A" : kind === "delete" ? "D" : kind === "rename" ? "R" : kind === "unmerged" ? "!" : "M";
  return `${prefix} ${change.path}`;
}

export interface NativeCommitTreeSelection {
  readonly hashes: ReadonlySet<string>;
  readonly contiguous: boolean;
}

export function nativeCommitTreeItem(
  element: NativeCommitTreeElement,
  selection: NativeCommitTreeSelection = { hashes: new Set<string>(), contiguous: true }
): vscode.TreeItem {
  if (element.kind === "commit") {
    const { commit, detail, locked, stopped, pending } = element;
    const item = new vscode.TreeItem(commit.subject || "(no subject)", vscode.TreeItemCollapsibleState.None);
    item.id = `commit:${commit.hash}`;
    item.description = `${commit.shortHash} · ${commit.author} · ${commit.date}`;
    item.tooltip = commitTooltip(commit, detail);
    const selected = selection.hashes.has(commit.hash);
    const batch = selection.hashes.size > 1;
    item.contextValue = [
      "gitRebaseVisual.commit",
      locked ? "gitRebaseVisual.commit.locked" : undefined,
      selected ? "gitRebaseVisual.commit.selected" : undefined,
      batch ? "gitRebaseVisual.commit.batch" : undefined,
      batch && selection.contiguous ? "gitRebaseVisual.commit.batch.contiguous" : undefined,
    ].filter(Boolean).join(" ");
    item.iconPath = new vscode.ThemeIcon(locked ? "lock" : stopped ? "debug-pause" : pending ? "history" : "git-commit");
    item.command = {
      command: "gitRebaseVisual.commit.copyHash",
      title: "Copy Commit Hash",
      arguments: [element],
    };
    return item;
  }

  if (element.kind === "worktree") {
    const { change, side } = element;
    const kind = side === "staged" ? change.indexKind : change.worktreeKind;
    const item = new vscode.TreeItem(worktreeLabel(change, side), vscode.TreeItemCollapsibleState.None);
    item.id = `worktree:${side}:${change.path}`;
    item.description = side === "staged" ? "Staged" : kind === "untracked" ? "Untracked" : "Changes";
    item.tooltip = change.path;
    item.contextValue = side === "working" && kind === "untracked"
      ? "gitRebaseVisual.worktree.untracked"
      : side === "staged"
        ? "gitRebaseVisual.worktree.staged"
        : "gitRebaseVisual.worktree.working";
    item.iconPath = new vscode.ThemeIcon(kind === "untracked" ? "new-file" : kind === "delete" ? "trash" : "diff-modified");
    return item;
  }

  const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
  item.id = `message:${element.label}`;
  item.tooltip = element.tooltip ?? element.label;
  item.contextValue = "gitRebaseVisual.message";
  item.iconPath = new vscode.ThemeIcon("info");
  return item;
}

/** A native tree model: its tooltip and context menu are rendered by VS Code, not an iframe. */
export class NativeCommitTreeProvider implements vscode.TreeDataProvider<NativeCommitTreeElement> {
  private readonly emitter = new vscode.EventEmitter<NativeCommitTreeElement | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private elements: NativeCommitTreeElement[] = [];
  private selection: NativeCommitTreeSelection = { hashes: new Set<string>(), contiguous: true };

  setElements(elements: readonly NativeCommitTreeElement[]): void {
    this.elements = [...elements];
    this.emitter.fire();
  }

  setSelection(selection: NativeCommitTreeSelection): void {
    this.selection = selection;
    this.emitter.fire();
  }

  getTreeItem(element: NativeCommitTreeElement): vscode.TreeItem {
    return nativeCommitTreeItem(element, this.selection);
  }

  getChildren(element?: NativeCommitTreeElement): NativeCommitTreeElement[] {
    return element ? [] : this.elements;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
