import { FileChangeKind, WorktreeChange } from "../git/worktreeChanges";

export type DiffVersion = "head" | "index" | "working" | "empty";

export interface WorktreeDiffSpec {
  left: DiffVersion;
  right: DiffVersion;
  leftPath: string;
  rightPath: string;
  title: string;
  fallbackReason?: string;
}

function label(kind: FileChangeKind | undefined): string {
  switch (kind) {
    case "add": return "Add";
    case "delete": return "Delete";
    case "rename": return "Rename";
    case "untracked": return "Untracked";
    case "unmerged": return "Conflict";
    default: return "Modify";
  }
}

function emptyFor(kind: FileChangeKind | undefined): boolean {
  return kind === "add" || kind === "untracked";
}

/** Pure SCM-style left/right version selection, including root/add/delete cases. */
export function worktreeDiffSpec(change: WorktreeChange): WorktreeDiffSpec {
  const rightPath = change.path;
  if (change.conflicted) {
    return {
      left: "index", right: "working", leftPath: change.path, rightPath,
      title: `${label("unmerged")}: ${change.path}`,
      fallbackReason: "该文件仍有冲突阶段；请在 VS Code SCM 解决冲突后再比较。",
    };
  }
  if (change.worktreeKind === "untracked") {
    return { left: "empty", right: "working", leftPath: change.path, rightPath, title: `Untracked: ${change.path}` };
  }
  if (change.unstaged) {
    const leftPath = change.worktreeKind === "rename" ? (change.originalPath ?? change.path) : change.path;
    return { left: "index", right: change.worktreeKind === "delete" ? "empty" : "working", leftPath, rightPath, title: `${label(change.worktreeKind)} (index ↔ working tree): ${change.path}` };
  }
  const leftPath = change.indexKind === "rename" ? (change.originalPath ?? change.path) : change.path;
  // A root commit has no HEAD parent. Git is still the authority for whether
  // HEAD:path exists, but an index-side add is unambiguously empty on the left.
  return { left: emptyFor(change.indexKind) ? "empty" : "head", right: change.indexKind === "delete" ? "empty" : "index", leftPath, rightPath, title: `${label(change.indexKind)} (HEAD ↔ index): ${change.path}` };
}
