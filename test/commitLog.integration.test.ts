import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as path from "path";
import { currentBranch, getCommits, isRebaseInProgress, rebaseStoppedSha, resolveRange, workingStatus } from "../src/git/commitLog";
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
