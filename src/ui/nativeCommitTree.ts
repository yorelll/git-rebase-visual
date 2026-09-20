import * as vscode from "vscode";
import { Commit, CommitDetail } from "../git/commitLog";
import { WorktreeChange } from "../git/worktreeChanges";

export const nativeCommitTreeViewId = "gitRebaseVisual.commits";
export const nativeCommitTreeMime = "application/vnd.code.tree.gitrebasevisual.commits";

/** One stable primary context is required by VS Code's `viewItem == value` menu grammar. */
export const nativeCommitContext = "gitRebaseVisual.commit";
export const nativeLockedCommitContext = "gitRebaseVisual.commit.locked";
export const nativeSelectedCommitContext = "gitRebaseVisual.commit.selected";
export const nativeBatchCommitContext = "gitRebaseVisual.commit.batch";
export const nativeContiguousBatchCommitContext = "gitRebaseVisual.commit.batch.contiguous";
export const nativeLockedBatchCommitContext = "gitRebaseVisual.commit.locked.batch";
export const nativeLockedContiguousBatchCommitContext = "gitRebaseVisual.commit.locked.batch.contiguous";

export type NativeCommitTreeElement =
  | NativeCommitTreeCommit
  | NativeCommitTreeWorktreeChange
  | NativeCommitTreeMessage
  | NativeCommitTreeLockedRun;

export interface NativeCommitTreeCommit {
  readonly kind: "commit";
  readonly commit: Commit;
  readonly locked: boolean;
  readonly stopped: boolean;
  readonly pending: boolean;
  /** Filled lazily after a row is selected; fallback tooltip remains accurate. */
  detail?: CommitDetail;
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
  /** Makes a message row a native command target without an editor-panel shim. */
  readonly context?: "rebase" | "editStop" | "worktreeStaged" | "worktreeWorking";
  readonly rebase?: NativeRebaseActionState;
}

export interface NativeCommitTreeLockedRun {
  readonly kind: "lockedRun";
  /** The compact native summary replaces the long locked run in normal flow. */
  readonly commits: readonly NativeCommitTreeCommit[];
}

export interface NativeRebaseActionState {
  readonly pausedReason?: "conflict" | "edit" | "paused";
  readonly conflictCount: number;
  readonly stoppedCommit?: NativeCommitTreeCommit;
  readonly hasStaged: boolean;
  readonly llmConfigured: boolean;
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

/**
 * Produces the exact historical summary format in a native collapsible TreeView
 * row. Full author names remain in the tooltip so compact abbreviations do not
 * discard semantics.
 */
export function lockedRunSummary(commits: readonly NativeCommitTreeCommit[]): {
  label: string;
  tooltip: string;
} {
  const authors = new Map<string, number>();
  for (const { commit } of commits) {
    const name = commit.author.trim() || "?";
    authors.set(name, (authors.get(name) ?? 0) + 1);
  }
  const compact = [...authors].map(([author, count]) => `${author.slice(0, 2) || "?"} ×${count}`).join(" · ");
  const label = `🔒 : ${commits.length} lock · no push${compact ? ` · ${compact}` : ""}`;
  const tooltip = `已锁定 ${commits.length} 个 commit；不会被推送。${[...authors].map(([author, count]) => `${author} ×${count}`).join(" · ")}`;
  return { label, tooltip };
}

function commitContext(element: NativeCommitTreeCommit, selection: NativeCommitTreeSelection): string {
  const selected = selection.hashes.has(element.commit.hash);
  const batch = selection.hashes.size > 1;
  // Each TreeItem has exactly one context value. The ordinary primary context
  // intentionally survives selection; special contexts are for menus which
  // must only apply to those states.
  if (batch && selected) {
    if (element.locked) return selection.contiguous ? nativeLockedContiguousBatchCommitContext : nativeLockedBatchCommitContext;
    return selection.contiguous ? nativeContiguousBatchCommitContext : nativeBatchCommitContext;
  }
  if (element.locked) return nativeLockedCommitContext;
  // Selection itself must not hide the ordinary single-item command set.
  if (selected) return nativeCommitContext;
  return nativeCommitContext;
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
    item.contextValue = commitContext(element, selection);
    item.iconPath = new vscode.ThemeIcon(locked ? "lock" : stopped ? "debug-pause" : pending ? "history" : "git-commit");
    item.command = {
      command: "gitRebaseVisual.commit.openDiff",
      title: "Open Commit Diff",
      arguments: [element],
    };
    return item;
  }

  if (element.kind === "lockedRun") {
    const summary = lockedRunSummary(element.commits);
    const item = new vscode.TreeItem(summary.label, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `locked-run:${element.commits.map(({ commit }) => commit.hash).join(":")}`;
    item.tooltip = summary.tooltip;
    item.contextValue = "gitRebaseVisual.lockedRun";
    item.iconPath = new vscode.ThemeIcon("lock");
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
    // Native inline affordances: selection/open works exactly like the former
    // file-name target while all writes remain in host commands and confirmations.
    item.command = { command: "gitRebaseVisual.worktree.openDiff", title: "Open Diff", arguments: [element] };
    return item;
  }

  const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
  item.id = `message:${element.context ?? "plain"}:${element.label}`;
  item.tooltip = element.tooltip ?? element.label;
  item.contextValue = element.context === "rebase"
    ? "gitRebaseVisual.rebase"
    : element.context === "editStop"
      ? "gitRebaseVisual.editStop"
      : element.context === "worktreeStaged"
        ? "gitRebaseVisual.worktree.stagedSection"
        : element.context === "worktreeWorking"
          ? "gitRebaseVisual.worktree.workingSection"
          : "gitRebaseVisual.message";
  item.iconPath = new vscode.ThemeIcon(element.context === "rebase" || element.context === "editStop" ? "debug-pause" : "info");
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

  /** Updates one immutable row's tooltip after an on-demand Git metadata read. */
  setCommitDetail(hash: string, detail: CommitDetail): void {
    const update = (element: NativeCommitTreeElement): NativeCommitTreeElement => {
      if (element.kind === "commit") {
        return element.commit.hash === hash ? { ...element, detail } : element;
      }
      if (element.kind === "lockedRun") {
        return { ...element, commits: element.commits.map((commit) => commit.commit.hash === hash ? { ...commit, detail } : commit) };
      }
      return element;
    };
    this.elements = this.elements.map(update);
    this.emitter.fire();
  }

  getTreeItem(element: NativeCommitTreeElement): vscode.TreeItem {
    return nativeCommitTreeItem(element, this.selection);
  }

  getChildren(element?: NativeCommitTreeElement): NativeCommitTreeElement[] {
    if (element?.kind === "lockedRun") return [...element.commits];
    return element ? [] : this.elements;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
