import * as fs from "fs/promises";
import * as pathModule from "path";
import { runGit } from "./gitRunner";

/** A UI-safe classification of a status side from `git status --porcelain=v2 -z`. */
export type FileChangeKind = "modify" | "add" | "delete" | "rename" | "untracked" | "unmerged";

export interface WorktreeChange {
  /** Current path for normal/add/rename records; tracked path for deletions. */
  path: string;
  /** Pre-rename path when porcelain provides one. */
  originalPath?: string;
  /** True when the index differs from HEAD. */
  staged: boolean;
  /** True when the working tree differs from the index, including untracked files. */
  unstaged: boolean;
  /** Classification for the index (HEAD → index) side. */
  indexKind?: FileChangeKind;
  /** Classification for the worktree (index → working tree) side. */
  worktreeKind?: FileChangeKind;
  /** Conflict records cannot safely be staged as an individual ordinary change. */
  conflicted: boolean;
}

export interface WorktreeStatusSummary {
  hasStaged: boolean;
  hasUnstaged: boolean;
  stagedCount: number;
  unstagedCount: number;
}

const BACKGROUND_STATUS_ENV: NodeJS.ProcessEnv = {
  GIT_OPTIONAL_LOCKS: "0",
};

/**
 * Takes fixed porcelain header fields without ever treating a pathname as a
 * line. Paths may contain spaces, tabs, quotes, or newlines; `-z` is the only
 * record delimiter Git emits here.
 */
function takeFields(value: string, count: number): { fields: string[]; rest: string } | undefined {
  const fields: string[] = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const next = value.indexOf(" ", offset);
    if (next < 0) return undefined;
    fields.push(value.slice(offset, next));
    offset = next + 1;
  }
  return { fields, rest: value.slice(offset) };
}

function kindForStatus(status: string, untracked = false): FileChangeKind | undefined {
  if (untracked) return "untracked";
  switch (status) {
    case "M":
    case "T":
      return "modify";
    case "A":
    case "C":
      return "add";
    case "D":
      return "delete";
    case "R":
      return "rename";
    case "U":
      return "unmerged";
    default:
      return undefined;
  }
}

function hasStatus(status: string | undefined): boolean {
  return !!status && status !== "." && status !== " ";
}

/**
 * Parses the structured v2 `-z` status protocol. This deliberately does not
 * split output into lines: a valid Git pathname can itself contain a newline.
 */
export function parseWorktreeChanges(output: string): WorktreeChange[] {
  const records = output.split("\0");
  const changes: WorktreeChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.startsWith("# ")) continue;

    if (record.startsWith("? ")) {
      const path = record.slice(2);
      if (path) {
        changes.push({
          path,
          staged: false,
          unstaged: true,
          worktreeKind: "untracked",
          conflicted: false,
        });
      }
      continue;
    }
    if (record.startsWith("! ")) continue;

    if (record.startsWith("1 ")) {
      // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
      const parsed = takeFields(record.slice(2), 7);
      if (!parsed || !parsed.rest) continue;
      const xy = parsed.fields[0] ?? "..";
      const x = xy[0];
      const y = xy[1];
      changes.push({
        path: parsed.rest,
        staged: hasStatus(x),
        unstaged: hasStatus(y),
        indexKind: kindForStatus(x),
        worktreeKind: kindForStatus(y),
        conflicted: false,
      });
      continue;
    }

    if (record.startsWith("2 ")) {
      // `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<orig-path>`
      const parsed = takeFields(record.slice(2), 8);
      if (!parsed || !parsed.rest) continue;
      const originalPath = records[++index];
      const xy = parsed.fields[0] ?? "..";
      const x = xy[0];
      const y = xy[1];
      changes.push({
        path: parsed.rest,
        originalPath: originalPath || undefined,
        staged: hasStatus(x),
        unstaged: hasStatus(y),
        indexKind: kindForStatus(x),
        worktreeKind: kindForStatus(y),
        conflicted: false,
      });
      continue;
    }

    if (record.startsWith("u ")) {
      // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
      const parsed = takeFields(record.slice(2), 9);
      if (!parsed || !parsed.rest) continue;
      changes.push({
        path: parsed.rest,
        staged: true,
        unstaged: true,
        indexKind: "unmerged",
        worktreeKind: "unmerged",
        conflicted: true,
      });
    }
  }
  return changes;
}

export function summarizeWorktreeChanges(changes: readonly WorktreeChange[]): WorktreeStatusSummary {
  const stagedCount = changes.filter((change) => change.staged).length;
  const unstagedCount = changes.filter((change) => change.unstaged).length;
  return {
    hasStaged: stagedCount > 0,
    hasUnstaged: unstagedCount > 0,
    stagedCount,
    unstagedCount,
  };
}

/** Reads all entries, including every untracked file, through porcelain v2 -z. */
export async function getWorktreeChanges(cwd: string): Promise<WorktreeChange[]> {
  const result = await runGit(
    ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    { cwd, env: BACKGROUND_STATUS_ENV }
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "无法读取 Git 工作区状态。");
  }
  return parseWorktreeChanges(result.stdout);
}

/**
 * Stages precisely one current working/untracked status entry. The control is
 * attached to the working-tree side, so its current pathname is the only
 * pathspec. In particular, an `RM` record has an index-side old rename path
 * that no longer exists in the worktree; passing it would make `git add -A`
 * fail before it can stage the modification at the new path.
 */
export async function stageWorktreeChange(cwd: string, change: WorktreeChange): Promise<void> {
  if (!change.unstaged || change.conflicted) {
    throw new Error("该文件不是可单独暂存的工作区改动。");
  }
  const result = await runGit(["add", "-A", "--", change.path], { cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `无法暂存 ${change.path}。`);
  }
}

/**
 * Restores only one visible status side. Working restoration resets index →
 * worktree; staged restoration resets HEAD → index without touching the
 * worktree. Untracked files are never silently deleted: that operation needs a
 * deliberate filesystem confirmation in the host.
 */
export async function restoreWorktreeChange(
  cwd: string,
  change: WorktreeChange,
  side: "working" | "staged"
): Promise<void> {
  if (change.conflicted) {
    throw new Error("冲突文件不能通过此处恢复；请在编辑器解决冲突。 ");
  }
  if (side === "working") {
    if (!change.unstaged) throw new Error("该文件没有可恢复的工作区改动。 ");
    if (change.worktreeKind === "untracked") {
      throw new Error("未跟踪文件不会自动删除；请在资源管理器中确认后手动删除。 ");
    }
    const result = await runGit(["restore", "--worktree", "--", change.path], { cwd });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || `无法恢复工作区文件 ${change.path}。`);
    return;
  }

  if (!change.staged) throw new Error("该文件没有可恢复的暂存改动。 ");
  const paths = change.originalPath ? [change.path, change.originalPath] : [change.path];
  const result = await runGit(["restore", "--staged", "--", ...paths], { cwd });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || `无法撤销暂存 ${change.path}。`);
}

/** Deletes one displayed untracked file after the host obtained explicit confirmation. */
export async function deleteUntrackedWorktreeChange(cwd: string, change: WorktreeChange): Promise<void> {
  if (!change.unstaged || change.worktreeKind !== "untracked" || change.staged) {
    throw new Error("只有当前未跟踪文件可在确认后删除。 ");
  }
  const absolute = pathModule.resolve(cwd, change.path);
  const relative = pathModule.relative(cwd, absolute);
  if (relative === ".." || relative.startsWith(`..${pathModule.sep}`) || pathModule.isAbsolute(relative)) {
    throw new Error("Git 状态返回了仓库外路径；未删除文件。 ");
  }
  await fs.rm(absolute, { force: true });
}
