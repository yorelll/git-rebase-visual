import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as path from "path";
import {
  stashApplyIndexBySha,
  stashDropBySha,
  stashList,
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
  await stashDropBySha(cwd, second);
  await stashDropBySha(cwd, first);
  assert.deepEqual(await stashList(cwd), []);
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
