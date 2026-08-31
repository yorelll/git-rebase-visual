import { git, runGit } from "./gitRunner";

/**
 * Stashes all changes (including untracked) so a rebase can run on a clean
 * tree. Returns the stash commit sha when something was stashed, or undefined
 * when there was nothing to stash. The sha is a stable identity for the stash
 * that we later use to pop exactly our stash (unaffected by rebase rewriting
 * other commit hashes, and robust if the user creates other stashes).
 */
export async function stashPush(cwd: string): Promise<string | undefined> {
  return stash(cwd, ["--include-untracked"], "git-rebase-visual auto-stash");
}

/** Stashes unstaged changes while leaving the existing index intact. */
export async function stashPushKeepIndex(cwd: string): Promise<string | undefined> {
  return stash(cwd, ["--keep-index", "--include-untracked"], "git-rebase-visual preserve-unstaged");
}

async function stash(
  cwd: string,
  options: string[],
  message: string
): Promise<string | undefined> {
  const res = await runGit(["stash", "push", ...options, "-m", message], { cwd });
  if (res.code !== 0 || /No local changes to save/i.test(res.stdout + res.stderr)) {
    return undefined;
  }
  const ref = await runGit(["rev-parse", "stash@{0}"], { cwd });
  return ref.code === 0 ? ref.stdout.trim() : undefined;
}

/** Returns the stash list index (stash@{n}) whose commit matches sha, or -1. */
async function stashIndexBySha(cwd: string, sha: string): Promise<number> {
  const list = await runGit(["stash", "list", "--format=%H"], { cwd });
  if (list.code !== 0) {
    return -1;
  }
  const shas = list.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  return shas.indexOf(sha);
}

/**
 * Pops the stash identified by sha. If the stash is no longer present (e.g. the
 * user already popped it elsewhere), reports gone=true instead of erroring, so
 * callers can silently clear their pending-stash marker.
 */
export async function stashPopBySha(
  cwd: string,
  sha: string
): Promise<{ ok: boolean; gone: boolean; message: string }> {
  const idx = await stashIndexBySha(cwd, sha);
  if (idx < 0) {
    return { ok: false, gone: true, message: "stash no longer present" };
  }
  const res = await runGit(["stash", "pop", `stash@{${idx}}`], { cwd });
  return { ok: res.code === 0, gone: false, message: (res.stderr || res.stdout).trim() };
}

/** Applies a stash's original index without dropping its recovery copy. */
export async function stashApplyIndexBySha(
  cwd: string,
  sha: string
): Promise<{ ok: boolean; gone: boolean; message: string }> {
  const idx = await stashIndexBySha(cwd, sha);
  if (idx < 0) {
    return { ok: false, gone: true, message: "stash no longer present" };
  }
  const res = await runGit(["stash", "apply", "--index", `stash@{${idx}}`], { cwd });
  return { ok: res.code === 0, gone: false, message: (res.stderr || res.stdout).trim() };
}

/** Removes a stash by its stable commit sha. */
export async function stashDropBySha(cwd: string, sha: string): Promise<void> {
  const idx = await stashIndexBySha(cwd, sha);
  if (idx >= 0) {
    await git(["stash", "drop", `stash@{${idx}}`], { cwd });
  }
}

/** Pops the most recent stash (stash@{0}). Reports empty when none exist. */
export async function stashPopManual(
  cwd: string
): Promise<{ ok: boolean; empty: boolean; message: string }> {
  const list = await runGit(["stash", "list"], { cwd });
  if (!list.stdout.trim()) {
    return { ok: false, empty: true, message: "" };
  }
  const res = await runGit(["stash", "pop"], { cwd });
  return { ok: res.code === 0, empty: false, message: (res.stderr || res.stdout).trim() };
}

/**
 * Creates a commit from the current index with the given message. Uses -s so a
 * Signed-off-by trailer is added (matching a normal `git commit -s`); the
 * repo's commit-msg hook still appends Change-Id as usual.
 */
export async function commitIndex(cwd: string, message: string): Promise<void> {
  await git(["commit", "-s", "-m", message], { cwd });
}

/** Stages all changes then commits with the given message (signed off). */
export async function commitAll(cwd: string, message: string): Promise<void> {
  await git(["add", "-A"], { cwd });
  await git(["commit", "-s", "-m", message], { cwd });
}
