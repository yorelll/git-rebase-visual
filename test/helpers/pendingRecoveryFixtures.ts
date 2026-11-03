import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { runGit } from "../../src/git/gitRunner";
import { stashNameForSha } from "../../src/git/pendingRecovery";
import { stashPush } from "../../src/git/worktree";
import { commitFile, createRepo, git, removeRepo } from "./gitTestRepo";

/**
 * Fixtures shared by the three `pendingRecovery` integration files.
 *
 * They live here rather than being copied into each file so a change to a
 * fixture cannot reach one shard and miss the others. Every one of them only
 * creates state inside the repo it is handed; none of them keeps anything at
 * module level, so the three files stay independent of each other and of the
 * order Node happens to run them in.
 */

/** Aborts any paused rebase so the temp directory can be removed. */
export function cleanup(t: { after: (fn: () => void) => void }, cwd: string): void {
  t.after(() => {
    const rebaseState = git(cwd, ["rev-parse", "--git-path", "rebase-merge"]);
    if (fs.existsSync(path.join(cwd, rebaseState))) {
      git(cwd, ["rebase", "--abort"]);
    }
    removeRepo(cwd);
  });
}

/** Creates a repo with a staged file plus an untracked file, then stashes both. */
export async function stashSnapshot(cwd: string): Promise<{ sha: string }> {
  fs.writeFileSync(path.join(cwd, "staged.txt"), "staged content\n", "utf8");
  git(cwd, ["add", "staged.txt"]);
  fs.writeFileSync(path.join(cwd, "untracked.txt"), "untracked content\n", "utf8");
  const sha = await stashPush(cwd);
  assert.ok(sha, "stash was created");
  return { sha };
}

/** Deletes a loose object so the corresponding Git read fails hard. */
export function deleteLooseObject(cwd: string, objectId: string): void {
  const file = path.join(cwd, git(cwd, ["rev-parse", "--git-path", "objects"]), objectId.slice(0, 2), objectId.slice(2));
  assert.ok(fs.existsSync(file), `object ${objectId.slice(0, 7)} exists before deletion`);
  fs.rmSync(file);
}

/** Exact sha set of `git stash list`, oldest last, for order-insensitive equality. */
export function stashShaSet(cwd: string): string[] {
  return git(cwd, ["stash", "list", "--format=%H"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

/** A stash the extension did not create, on its own file. */
export function pushUserStash(cwd: string, name: string): string {
  fs.writeFileSync(path.join(cwd, `${name}.txt`), `${name}\n`, "utf8");
  git(cwd, ["stash", "push", "-u", "-q", "-m", `user ${name}`]);
  return git(cwd, ["rev-parse", "stash@{0}"]);
}

/**
 * Runs one printed command against a fresh repo holding the same stash.
 *
 * The steps are alternatives, not a sequence: applying twice would conflict on
 * the untracked file, so each must be evaluated on its own repository.
 */
export async function runOneCommandPerRepo(command: string): Promise<void> {
  const cwd = createRepo();
  try {
    commitFile(cwd, "base.txt", "base\n", "base");
    const { sha } = await stashSnapshot(cwd);
    const name = await stashNameForSha(cwd, sha);
    const resolved = command.replace("${target}", name ?? sha);
    const res = await runGit(resolved.replace(/^git /, "").split(" "), { cwd });
    assert.equal(res.code, 0, `${resolved} must succeed: ${res.stderr}`);
  } finally {
    removeRepo(cwd);
  }
}
