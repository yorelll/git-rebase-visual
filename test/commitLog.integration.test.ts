import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as path from "path";
import { clearPatchIdCache, commitDetail, conflictedFiles, currentBranch, getCommits, isRebaseInProgress, patchId, rebaseStoppedSha, resolveRange, summarizeNumstat, workingStatus } from "../src/git/commitLog";
import { resolveBase } from "../src/git/rebaseEngine";
import { createRepo, commitFile, git, removeRepo } from "./helpers/gitTestRepo";

test("workingStatus distinguishes staged, unstaged, and untracked changes", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  commitFile(cwd, "one.txt", "one\n", "initial");

  fs.writeFileSync(path.join(cwd, "one.txt"), "staged\n", "utf8");
  git(cwd, ["add", "one.txt"]);
  fs.writeFileSync(path.join(cwd, "two.txt"), "untracked\n", "utf8");
  assert.deepEqual(await workingStatus(cwd), { hasStaged: true, hasUnstaged: true });
});

test("commit queries preserve newest-first order and calculate a rebase base", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  const first = commitFile(cwd, "one.txt", "one\n", "first");
  const second = commitFile(cwd, "two.txt", "two\n", "second");

  const commits = await getCommits(cwd, "HEAD");
  assert.deepEqual(commits.map((commit) => commit.hash), [second, first]);
  assert.deepEqual(await resolveBase(cwd, second), { root: false, base: first });
  assert.equal(await currentBranch(cwd), "master");
  assert.deepEqual(await resolveRange(cwd, { kind: "recentN", count: 0 }), {
    revRange: "-n 1 HEAD",
    hasBase: false,
  });
});

test("conflictedFiles returns no paths in a clean repository", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  commitFile(cwd, "one.txt", "one\n", "initial");
  assert.deepEqual(await conflictedFiles(cwd), []);
});

test("patchId is stable across a cherry-pick and served by the session cache", async (t) => {
  const cwd = createRepo();
  t.after(() => {
    clearPatchIdCache();
    removeRepo(cwd);
  });
  const base = commitFile(cwd, "base.txt", "base\n", "base");
  const first = commitFile(cwd, "one.txt", "one\n", "first");
  commitFile(cwd, "two.txt", "two\n", "second");
  // Rewrite the same change elsewhere: cherry-picking `first` onto a side
  // branch at `base` yields a new hash but the identical patch-id. (The base
  // commit keeps `first` from being a root commit, whose diff-tree cannot
  // establish a patch-id.) The side branch avoids resetting the worktree, so
  // the cherry-pick cleanly re-applies the new-file change.
  const branchName = git(cwd, ["symbolic-ref", "--short", "HEAD"]);
  git(cwd, ["switch", "-c", "side", base]);
  git(cwd, ["cherry-pick", first]);
  git(cwd, ["switch", branchName]);

  const rewritten = git(cwd, ["rev-parse", "side"]);
  assert.notEqual(rewritten, first);
  const pidBefore = await patchId(cwd, first);
  const pidAfter = await patchId(cwd, rewritten);
  assert.ok(pidBefore);
  assert.equal(pidAfter, pidBefore);
  // Second lookup is cached — same result.
  assert.equal(await patchId(cwd, first), pidBefore);
});

test("clearPatchIdCache forces a fresh patch-id computation", async (t) => {
  const cwd = createRepo();
  t.after(() => {
    clearPatchIdCache();
    removeRepo(cwd);
  });
  const hash = commitFile(cwd, "one.txt", "one\n", "first");
  const pid = await patchId(cwd, hash);
  assert.ok(pid);
  clearPatchIdCache();
  assert.equal(await patchId(cwd, hash), pid);
});

test("commitDetail reports a structured numstat summary", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  const hash = commitFile(cwd, "one.txt", "one\n", "initial");
  fs.writeFileSync(path.join(cwd, "one.txt"), "one\nmore\n", "utf8");
  fs.writeFileSync(path.join(cwd, "two.txt"), "two\n", "utf8");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-qm", "adds"]);
  const detail = await commitDetail(cwd, git(cwd, ["rev-parse", "HEAD"]));
  assert.match(detail.stat, /2 files changed/);
  assert.match(detail.stat, /2 insertions\(\+\)/);
  assert.doesNotMatch(detail.stat, /deletion/); // zero-contribution counts are omitted
  void hash;
});

test("summarizeNumstat formats structured stat lines deterministically", () => {
  // Binary lines (`-` in a column) count as a changed file without +/- counts;
  // header/blank/subject lines are skipped as non-data rows.
  assert.equal(
    summarizeNumstat(["3\t1\tfile.txt", "1\t-\tbin.dat", "commit 0123456789abcdef0123456789abcdef01234567"]),
    "2 files changed, 3 insertions(+), 1 deletion(-)"
  );
  assert.equal(summarizeNumstat(["1\t2\ta.ts", "2\t0\tb.ts"]), "2 files changed, 3 insertions(+), 2 deletions(-)");
  assert.equal(summarizeNumstat(["1\t2\ta.ts", "0\t1\tb.ts"]), "2 files changed, 1 insertion(+), 3 deletions(-)");
  assert.equal(summarizeNumstat(["cfa7ed6357450347aa5de5da3ae1eb6de589b5eb"]), "");
  assert.equal(summarizeNumstat([]), "");
});

test("rebase state helpers find an edit stop via absolute Git paths", async (t) => {
  const cwd = createRepo();
  t.after(() => {
    try {
      git(cwd, ["rebase", "--abort"]);
    } catch {
      // No rebase may remain after a failed setup.
    }
    removeRepo(cwd);
  });
  commitFile(cwd, "one.txt", "one\n", "first");
  const second = commitFile(cwd, "two.txt", "two\n", "second");
  const editor = path.join(cwd, "editor.js");
  fs.writeFileSync(
    editor,
    "const fs=require('fs'); const file=process.argv[2]; fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^pick /m, 'edit '));\n",
    "utf8"
  );
  const env = { ...process.env, GIT_SEQUENCE_EDITOR: `\"${process.execPath}\" \"${editor}\"`, GIT_EDITOR: "true" };
  const { execFileSync } = await import("child_process");
  execFileSync("git", ["rebase", "-i", "HEAD~1"], { cwd, env, stdio: "pipe" });

  assert.equal(await isRebaseInProgress(cwd), true);
  assert.equal(await rebaseStoppedSha(cwd), second);
});
