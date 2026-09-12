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
 * Stages precisely one current working/untracked status entry. Both sides of a
 * rename are passed as independent spawn arguments so `git add -A` records its
 * deletion as well as its destination; paths are never interpolated into a
 * shell command.
 */
export async function stageWorktreeChange(cwd: string, change: WorktreeChange): Promise<void> {
  if (!change.unstaged || change.conflicted) {
    throw new Error("该文件不是可单独暂存的工作区改动。");
  }
  const paths = [...new Set([change.path, change.originalPath].filter((value): value is string => !!value))];
  const result = await runGit(["add", "-A", "--", ...paths], { cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `无法暂存 ${change.path}。`);
  }
}
