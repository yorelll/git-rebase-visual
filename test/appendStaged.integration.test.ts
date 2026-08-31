import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as path from "path";
import { isRebaseInProgress, rebaseStoppedSha } from "../src/git/commitLog";
import { continueRebase, executeRebase, resolveBase } from "../src/git/rebaseEngine";
import { stashApplyIndexBySha, stashDropBySha, stashPopBySha, stashPush, stashPushKeepIndex } from "../src/git/worktree";
import { createRepo, commitFile, git, removeRepo } from "./helpers/gitTestRepo";

test("append transaction amends only the original index and restores worktree changes", async (t) => {
  const cwd = createRepo();
  t.after(() => {
    const rebaseState = git(cwd, ["rev-parse", "--git-path", "rebase-merge"]);
    if (fs.existsSync(path.join(cwd, rebaseState))) {
      git(cwd, ["rebase", "--abort"]);
    }
    removeRepo(cwd);
  });

  const first = commitFile(cwd, "first.txt", "first\n", "first");
  const target = commitFile(cwd, "target.txt", "target\n", "target");
  const tip = commitFile(cwd, "later.txt", "later\n", "later");
  fs.writeFileSync(path.join(cwd, "append.txt"), "append\n", "utf8");
  git(cwd, ["add", "append.txt"]);
  fs.writeFileSync(path.join(cwd, "untracked.txt"), "keep me\n", "utf8");

  const snapshot = await stashPush(cwd);
  assert.ok(snapshot);
  const outcome = await executeRebase(cwd, {
    onto: await resolveBase(cwd, first),
    items: [
      { hash: first, action: "pick", subject: "first" },
      { hash: target, action: "edit", subject: "target" },
      { hash: tip, action: "pick", subject: "later" },
    ],
  });
  assert.equal(outcome.stopped, true);
  assert.equal(await isRebaseInProgress(cwd), true);
  assert.equal(await rebaseStoppedSha(cwd), target);

  const applied = await stashApplyIndexBySha(cwd, snapshot);
  assert.equal(applied.ok, true);
  git(cwd, ["commit", "--amend", "--no-edit"]);
  const worktreeStash = await stashPushKeepIndex(cwd);
  assert.ok(worktreeStash);

  const completed = await continueRebase(cwd);
  assert.equal(completed.ok, true);
  assert.equal(await isRebaseInProgress(cwd), false);
  const restored = await stashPopBySha(cwd, worktreeStash);
  assert.equal(restored.ok, true);
  await stashDropBySha(cwd, snapshot);

  const targetAfter = git(cwd, ["rev-parse", "HEAD~1"]);
  assert.notEqual(targetAfter, target);
  assert.equal(git(cwd, ["show", `${targetAfter}:append.txt`]), "append");
  assert.equal(git(cwd, ["show", "-s", "--format=%s", "HEAD"]), "later");
  assert.equal(fs.readFileSync(path.join(cwd, "untracked.txt"), "utf8").replace(/\r\n/g, "\n"), "keep me\n");
  assert.equal(git(cwd, ["stash", "list"]), "");
});
