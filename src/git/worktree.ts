import { git, runGit } from "./gitRunner";

/**
 * Stashes all changes (including untracked) so a rebase can run on a clean
 * tree. Returns true if something was stashed. Uses a recognizable message.
 */
export async function stashPush(cwd: string): Promise<boolean> {
  const res = await runGit(
    ["stash", "push", "--include-untracked", "-m", "git-rebase-visual auto-stash"],
    { cwd }
  );
  if (res.code !== 0) {
    return false;
  }
  return !/No local changes to save/i.test(res.stdout + res.stderr);
}

/** Pops the most recent stash. Returns the git result for conflict inspection. */
export async function stashPop(cwd: string): Promise<{ ok: boolean; message: string }> {
  const res = await runGit(["stash", "pop"], { cwd });
  return { ok: res.code === 0, message: (res.stderr || res.stdout).trim() };
}

/** Creates a commit from the current index with the given message. */
export async function commitIndex(cwd: string, message: string): Promise<void> {
  await git(["commit", "-m", message], { cwd });
}

/** Stages all changes then commits with the given message. */
export async function commitAll(cwd: string, message: string): Promise<void> {
  await git(["add", "-A"], { cwd });
  await git(["commit", "-m", message], { cwd });
}
