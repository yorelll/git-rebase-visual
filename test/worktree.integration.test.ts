import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as path from "path";
import {
  stashApplyIndexBySha,
  stashList,
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

  git(cwd, ["stash", "drop", "stash@{0}"]);
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

  git(cwd, ["stash", "pop"]);
  assert.match(git(cwd, ["status", "--porcelain"]), /^\?\? untracked\.txt/m);
});

test("stashList reports exact stash names and stable shas", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  commitFile(cwd, "tracked.txt", "base\n", "initial");

  fs.writeFileSync(path.join(cwd, "one.txt"), "one\n", "utf8");
  const first = await stashPush(cwd);
  assert.ok(first);
  fs.writeFileSync(path.join(cwd, "two.txt"), "two\n", "utf8");
  const second = await stashPush(cwd);
  assert.ok(second);

  const entries = await stashList(cwd);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].sha, second);
  assert.equal(entries[1].sha, first);
  assert.match(entries[0].name, /^stash@\{\d+\}$/);
  assert.notEqual(entries[0].name, entries[1].name);
  // Empty list when no stashes remain.
  git(cwd, ["stash", "drop", "stash@{0}"]);
  git(cwd, ["stash", "drop", "stash@{0}"]);
  assert.deepEqual(await stashList(cwd), []);
});

test("a stash removed behind Git's back is simply absent from the list", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  commitFile(cwd, "tracked.txt", "base\n", "initial");
  fs.writeFileSync(path.join(cwd, "untracked.txt"), "untracked\n", "utf8");

  const sha = await stashPush(cwd);
  assert.ok(sha);
  git(cwd, ["stash", "drop", "stash@{0}"]);
  // The extension exposes no pop/drop-by-sha helper any more; recovery only
  // applies, and absence is observed through the list.
  assert.deepEqual(await stashList(cwd), []);
});
