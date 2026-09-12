import { CommitFileChange, CommitFileChangeKind } from "./gitDiffRequestState";

const fullHash = /^[0-9a-f]{40}$/i;

export interface CommitDiffPlan {
  commit: string;
  parent?: string;
  files: CommitFileChange[];
  fallbackReason?: string;
}

function kindFor(status: string): CommitFileChangeKind | undefined {
  switch (status[0]) {
    case "A": return "add";
    case "D": return "delete";
    case "M":
    case "T": return "modify";
    case "R":
    case "C": return "rename";
    default: return undefined;
  }
}

/**
 * Parses `git diff-tree --name-status -z` output. Git emits a rename/copy
 * status, old path and new path as three distinct NUL records.
 */
export function parseCommitChangedFiles(output: string): CommitFileChange[] {
  const parts = output.split("\0");
  const files: CommitFileChange[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const status = parts[index];
    if (!status) continue;
    const kind = kindFor(status);
    if (!kind) continue;
    const firstPath = parts[++index];
    if (!firstPath) continue;
    if (kind === "rename") {
      // With `--name-status -z`, Git emits `R100\0old\0new\0`.
      const secondPath = parts[++index];
      if (secondPath) files.push({ kind, originalPath: firstPath, path: secondPath, binary: false });
      continue;
    }
    files.push({ kind, path: firstPath, binary: false });
  }
  return files;
}

/** Maps `git diff-tree --numstat -z` binary rows onto name-status entries. */
export function applyCommitBinaryStatus(files: readonly CommitFileChange[], output: string): CommitFileChange[] {
  const binaryPaths = new Set<string>();
  const parts = output.split("\0");
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    if (!record) continue;
    const first = record.indexOf("\t");
    const second = first < 0 ? -1 : record.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const added = record.slice(0, first);
    const deleted = record.slice(first + 1, second);
    const path = record.slice(second + 1);
    if (added !== "-" && deleted !== "-") continue;
    // Rename/copy numstat emits `-\t-\t\0old\0new\0`; ordinary rows contain
    // the pathname on this record.
    if (path) {
      binaryPaths.add(path);
    } else {
      const oldPath = parts[++index];
      const newPath = parts[++index];
      if (oldPath) binaryPaths.add(oldPath);
      if (newPath) binaryPaths.add(newPath);
    }
  }
  return files.map((file) => ({
    ...file,
    binary: binaryPaths.has(file.path) || (!!file.originalPath && binaryPaths.has(file.originalPath)),
  }));
}

/**
 * Builds a constrained plan after Git has resolved the exact object IDs. Merge
 * commits intentionally use the first parent only when unambiguous single-parent
 * history is available; users otherwise receive a clear raw-patch fallback.
 */
export function commitDiffPlan(
  commit: string,
  parents: readonly string[],
  files: readonly CommitFileChange[]
): CommitDiffPlan {
  if (!fullHash.test(commit)) {
    return { commit, files: [], fallbackReason: "Commit 标识无效，无法打开变更。" };
  }
  if (parents.some((parent) => !fullHash.test(parent))) {
    return { commit, files: [], fallbackReason: "Commit 父版本无效，无法打开变更。" };
  }
  if (parents.length > 1) {
    return {
      commit,
      files: [],
      fallbackReason: "合并 commit 有多个父版本；请使用 Git 的合并 Diff 视图或原始 patch 查看。",
    };
  }
  if (!files.length) {
    return { commit, parent: parents[0], files: [], fallbackReason: "该 commit 没有可比较的文件变更。" };
  }
  return { commit, parent: parents[0], files: [...files] };
}
