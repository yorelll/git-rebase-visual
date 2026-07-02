import { git, runGit } from "./gitRunner";

/**
 * Stashes all changes (including untracked) so a rebase can run on a clean
 * tree. Returns the stash commit sha when something was stashed, or undefined
 * when there was nothing to stash. The sha is a stable identity for the stash
 * that we later use to pop exactly our stash (unaffected by rebase rewriting
 * other commit hashes, and robust if the user creates other stashes).
 */
export async function stashPush(cwd: string): Promise<string | undefined> {
  const res = await runGit(
    ["stash", "push", "--include-untracked", "-m", "git-rebase-visual auto-stash"],
    { cwd }
  );
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

/** Creates a commit from the current index with the given message. */
export async function commitIndex(cwd: string, message: string): Promise<void> {
  await git(["commit", "-m", message], { cwd });
}

/** Stages all changes then commits with the given message. */
export async function commitAll(cwd: string, message: string): Promise<void> {
  await git(["add", "-A"], { cwd });
  await git(["commit", "-m", message], { cwd });
}
