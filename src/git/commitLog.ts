import { git, runGit } from "./gitRunner";

export interface Commit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

export type RangeConfig =
  | { kind: "upstream" }
  | { kind: "mainBranch"; mainBranch: string }
  | { kind: "recentN"; count: number }
  | { kind: "all" };

const SEP = "\x1f"; // unit separator, safe inside git format
const REC = "\x1e"; // record separator

/**
 * Resolves the git rev-range expression for the configured display range.
 * Returns undefined when the range cannot be resolved (e.g. no upstream set).
 */
export async function resolveRange(
  cwd: string,
  cfg: RangeConfig,
  tipRef: string = "HEAD"
): Promise<{ revRange: string; hasBase: boolean } | { error: string }> {
  switch (cfg.kind) {
    case "upstream": {
      const res = await runGit(
        [
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          `${tipRef}@{upstream}`,
        ],
        { cwd }
      );
      if (res.code !== 0) {
        return { error: "No upstream branch is configured for the current branch." };
      }
      return { revRange: `${tipRef}@{upstream}..${tipRef}`, hasBase: true };
    }
    case "mainBranch": {
      const res = await runGit(["rev-parse", "--verify", "--quiet", cfg.mainBranch], { cwd });
      if (res.code !== 0) {
        return { error: `Base branch '${cfg.mainBranch}' not found.` };
      }
      return { revRange: `${cfg.mainBranch}..${tipRef}`, hasBase: true };
    }
    case "recentN":
      return { revRange: `-n ${Math.max(1, cfg.count)} ${tipRef}`, hasBase: false };
    case "all":
      return { revRange: tipRef, hasBase: false };
  }
}

/**
 * When a rebase is in progress, returns the name of the branch being rebased
 * (from rebase-merge/head-name), so the UI can show that branch's commits
 * instead of failing on the detached HEAD.
 */
export async function rebasingBranch(cwd: string): Promise<string | undefined> {
  const res = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge/head-name"],
    { cwd }
  );
  if (res.code !== 0) {
    return undefined;
  }
  const fs = await import("fs");
  const abs = res.stdout.trim();
  try {
    if (fs.existsSync(abs)) {
      const ref = fs.readFileSync(abs, "utf8").trim(); // refs/heads/main
      return ref.replace(/^refs\/heads\//, "");
    }
  } catch {
    // ignore
  }
  return undefined;
}

/** Returns commits newest-first for the given resolved range. */
export async function getCommits(
  cwd: string,
  revRange: string
): Promise<Commit[]> {
  const format = ["%H", "%h", "%s", "%an", "%ad"].join(SEP) + REC;
  const args = [
    "log",
    "--date=short",
    `--pretty=format:${format}`,
    ...revRange.split(" "),
  ];
  const out = await git(args, { cwd });
  if (!out) {
    return [];
  }
  return out
    .split(REC)
    .map((r) => r.replace(/^\n/, ""))
    .filter((r) => r.trim().length > 0)
    .map((rec) => {
      const [hash, shortHash, subject, author, date] = rec.split(SEP);
      return { hash, shortHash, subject, author, date };
    });
}

/** True when a rebase (interactive or otherwise) is currently in progress. */
export async function isRebaseInProgress(cwd: string): Promise<boolean> {
  const [merge, apply] = await Promise.all(
    ["rebase-merge", "rebase-apply"].map((name) =>
      runGit(["rev-parse", "--path-format=absolute", "--git-path", name], { cwd })
    )
  );
  const fs = await import("fs");
  for (const abs of [merge.stdout.trim(), apply.stdout.trim()].filter(Boolean)) {
    try {
      if (fs.existsSync(abs)) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

/** Returns the current branch name, or undefined when detached. */
export async function currentBranch(cwd: string): Promise<string | undefined> {
  const res = await runGit(["symbolic-ref", "--short", "-q", "HEAD"], { cwd });
  return res.code === 0 ? res.stdout.trim() : undefined;
}

/**
 * When a rebase is paused (edit stop or after a resolved step), returns the
 * full hash of the commit it stopped at, or undefined if unavailable.
 */
export async function rebaseStoppedSha(cwd: string): Promise<string | undefined> {
  const res = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge/stopped-sha"],
    { cwd }
  );
  if (res.code !== 0) {
    return undefined;
  }
  const fs = await import("fs");
  const abs = res.stdout.trim();
  try {
    if (fs.existsSync(abs)) {
      const sha = fs.readFileSync(abs, "utf8").trim();
      // Expand to full hash for reliable comparison.
      const full = await runGit(["rev-parse", sha], { cwd });
      return full.code === 0 ? full.stdout.trim() : sha;
    }
  } catch {
    // ignore
  }
  return undefined;
}

/** Returns the repository top-level directory, or undefined when not a repo. */
export async function repoRoot(cwd: string): Promise<string | undefined> {
  const res = await runGit(["rev-parse", "--show-toplevel"], { cwd });
  return res.code === 0 ? res.stdout.trim() : undefined;
}

/** Returns the full commit message (subject + body) for a commit. */
export async function fullMessage(cwd: string, hash: string): Promise<string> {
  return git(["log", "-1", "--pretty=format:%B", hash], { cwd });
}

export interface CommitDetail {
  author: string;
  email: string;
  relDate: string;
  absDate: string;
  message: string;
  stat: string; // e.g. "8 files changed, 30 insertions(+), 2843 deletions(-)"
}

/** Fetches rich details for a commit, used for the hover tooltip. */
export async function commitDetail(cwd: string, hash: string): Promise<CommitDetail> {
  const fmt = ["%an", "%ae", "%ar", "%ad", "%B"].join("\x1f");
  const meta = await git(
    ["show", "-s", "--date=format:%Y-%m-%d %H:%M", `--pretty=format:${fmt}`, hash],
    { cwd }
  );
  const [author, email, relDate, absDate, message] = meta.split("\x1f");
  const statRes = await runGit(
    ["show", "--shortstat", "--oneline", "--no-color", hash],
    { cwd }
  );
  // Last non-empty line of --shortstat output holds the summary.
  const statLine =
    statRes.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /files? changed|insertion|deletion/.test(l))
      .pop() ?? "";
  return { author, email, relDate, absDate, message, stat: statLine };
}

export interface WorkingStatus {
  hasStaged: boolean;
  hasUnstaged: boolean; // includes untracked
}

/** Reports whether there are staged and/or unstaged (incl. untracked) changes. */
export async function workingStatus(cwd: string): Promise<WorkingStatus> {
  const res = await runGit(["status", "--porcelain"], { cwd });
  let hasStaged = false;
  let hasUnstaged = false;
  for (const line of res.stdout.split("\n")) {
    if (line.length < 2) {
      continue;
    }
    const x = line[0]; // staged column
    const y = line[1]; // worktree column
    if (line.startsWith("??")) {
      hasUnstaged = true;
      continue;
    }
    if (x !== " " && x !== "?") {
      hasStaged = true;
    }
    if (y !== " " && y !== "?") {
      hasUnstaged = true;
    }
  }
  return { hasStaged, hasUnstaged };
}

/** True when the working tree has any staged or unstaged changes. */
export async function isDirty(cwd: string): Promise<boolean> {
  const res = await runGit(["status", "--porcelain"], { cwd });
  return res.stdout.trim().length > 0;
}

/**
 * Computes a stable patch-id for a commit's diff. The patch-id stays the same
 * across cherry-pick and rebase (as long as the diff is unchanged), so it is a
 * reliable identity for "the same change" even when the commit hash changes.
 * Returns undefined for commits with no diff (e.g. merges).
 */
export async function patchId(cwd: string, hash: string): Promise<string | undefined> {
  const diff = await runGit(["diff-tree", "-p", "--no-color", hash], { cwd });
  if (diff.code !== 0 || !diff.stdout.trim()) {
    return undefined;
  }
  const res = await runGit(["patch-id", "--stable"], { cwd, input: diff.stdout });
  if (res.code !== 0) {
    return undefined;
  }
  const id = res.stdout.trim().split(/\s+/)[0];
  return id || undefined;
}
