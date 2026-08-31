import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as path from "path";
import {
  stashApplyIndexBySha,
  stashDropBySha,
  stashPopBySha,
  stashPush,
  stashPushKeepIndex,
} from "../src/git/worktree";
import { createRepo, commitFile, git, removeRepo } from "./helpers/gitTestRepo";

test("stash apply --index restores staged and unstaged changes before explicit cleanup", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  commitFile(cwd, "tracked.txt", "base\n", "initial");

  fs.writeFileSync(path.join(cwd, "tracked.txt"), "staged\n", "utf8");
  git(cwd, ["add", "tracked.txt"]);
  fs.writeFileSync(path.join(cwd, "untracked.txt"), "untracked\n", "utf8");

  const sha = await stashPush(cwd);
  assert.ok(sha);
  assert.equal(git(cwd, ["status", "--porcelain"]), "");

  const applied = await stashApplyIndexBySha(cwd, sha);
  assert.equal(applied.ok, true);
  assert.equal(applied.gone, false);
  const status = git(cwd, ["status", "--porcelain"]);
  assert.match(status, /^M  tracked\.txt/m);
  assert.match(status, /^\?\? untracked\.txt/m);

  await stashDropBySha(cwd, sha);
  assert.equal(git(cwd, ["stash", "list"]), "");
});

test("keep-index stash moves worktree-only changes without losing the index", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  commitFile(cwd, "tracked.txt", "base\n", "initial");

  fs.writeFileSync(path.join(cwd, "tracked.txt"), "staged\n", "utf8");
  git(cwd, ["add", "tracked.txt"]);
  fs.writeFileSync(path.join(cwd, "untracked.txt"), "untracked\n", "utf8");

  const sha = await stashPushKeepIndex(cwd);
  assert.ok(sha);
  assert.match(git(cwd, ["status", "--porcelain"]), /^M  tracked\.txt/m);
  assert.equal(fs.existsSync(path.join(cwd, "untracked.txt")), false);

  const popped = await stashPopBySha(cwd, sha);
  assert.equal(popped.ok, true);
  assert.equal(popped.gone, false);
  assert.match(git(cwd, ["status", "--porcelain"]), /^\?\? untracked\.txt/m);
});

test("stash helpers identify a manually removed stash without failing", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  commitFile(cwd, "tracked.txt", "base\n", "initial");
  fs.writeFileSync(path.join(cwd, "untracked.txt"), "untracked\n", "utf8");

  const sha = await stashPush(cwd);
  assert.ok(sha);
  git(cwd, ["stash", "drop", "stash@{0}"]);
  assert.deepEqual(await stashPopBySha(cwd, sha), {
    ok: false,
    gone: true,
    message: "stash no longer present",
  });
});
