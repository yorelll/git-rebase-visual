import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as path from "path";
import { deleteUntrackedWorktreeChange, getWorktreeChanges, restoreWorktreeChange, stageWorktreeChange } from "../src/git/worktreeChanges";
import { worktreeDiffSpec } from "../src/ui/worktreeDiffState";
import { commitFile, createRepo, git, removeRepo } from "./helpers/gitTestRepo";

test("porcelain v2 -z exposes staged and working status sides, robust paths, and diff choices", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  commitFile(cwd, "modified.txt", "base\n", "base");
  commitFile(cwd, "deleted.txt", "delete me\n", "delete base");
  commitFile(cwd, "rename old.txt", "rename me\n", "rename base");
  commitFile(cwd, "both.txt", "base\n", "both base");

  fs.writeFileSync(path.join(cwd, "modified.txt"), "working\n", "utf8");
  fs.unlinkSync(path.join(cwd, "deleted.txt"));
  git(cwd, ["mv", "rename old.txt", "rename new.txt"]);
  fs.writeFileSync(path.join(cwd, "staged add.txt"), "added\n", "utf8");
  git(cwd, ["add", "staged add.txt"]);
  fs.writeFileSync(path.join(cwd, "both.txt"), "index\n", "utf8");
  git(cwd, ["add", "both.txt"]);
  fs.writeFileSync(path.join(cwd, "both.txt"), "working after index\n", "utf8");
  // Windows does not permit newlines in names; spaces and brackets still prove
  // `-z` parsing / spawn args do not rely on whitespace splitting.
  fs.writeFileSync(path.join(cwd, "un tracked [name].txt"), "untracked\n", "utf8");

  const changes = await getWorktreeChanges(cwd);
  const byPath = new Map(changes.map((change) => [change.path, change]));
  const modified = byPath.get("modified.txt")!;
  const deleted = byPath.get("deleted.txt")!;
  const renamed = byPath.get("rename new.txt")!;
  const added = byPath.get("staged add.txt")!;
  const both = byPath.get("both.txt")!;
  const untracked = byPath.get("un tracked [name].txt")!;

  assert.deepEqual({ staged: modified.staged, unstaged: modified.unstaged, kind: modified.worktreeKind }, { staged: false, unstaged: true, kind: "modify" });
  assert.equal(deleted.worktreeKind, "delete");
  assert.equal(renamed.indexKind, "rename");
  assert.equal(renamed.originalPath, "rename old.txt");
  assert.equal(added.indexKind, "add");
  assert.deepEqual({ staged: both.staged, unstaged: both.unstaged, index: both.indexKind, working: both.worktreeKind }, { staged: true, unstaged: true, index: "modify", working: "modify" });
  assert.equal(untracked.worktreeKind, "untracked");

  assert.deepEqual(worktreeDiffSpec(modified), { left: "index", right: "working", leftPath: "modified.txt", rightPath: "modified.txt", title: "Modify (index ↔ working tree): modified.txt" });
  assert.deepEqual(worktreeDiffSpec(added), { left: "empty", right: "index", leftPath: "staged add.txt", rightPath: "staged add.txt", title: "Add (HEAD ↔ index): staged add.txt" });
  assert.deepEqual(worktreeDiffSpec(untracked), { left: "empty", right: "working", leftPath: "un tracked [name].txt", rightPath: "un tracked [name].txt", title: "Untracked: un tracked [name].txt" });
  assert.equal(worktreeDiffSpec(deleted).right, "empty");
  assert.equal(worktreeDiffSpec(renamed).leftPath, "rename old.txt");
});

test("single-file stage uses git add -A with paths containing spaces and deletion", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  commitFile(cwd, "delete me.txt", "gone\n", "base");
  fs.unlinkSync(path.join(cwd, "delete me.txt"));
  fs.writeFileSync(path.join(cwd, "a file [one].txt"), "new\n", "utf8");

  let changes = await getWorktreeChanges(cwd);
  await stageWorktreeChange(cwd, changes.find((change) => change.path === "delete me.txt")!);
  changes = await getWorktreeChanges(cwd);
  assert.equal(changes.find((change) => change.path === "delete me.txt")?.staged, true);
  assert.equal(changes.find((change) => change.path === "a file [one].txt")?.unstaged, true);

  await stageWorktreeChange(cwd, changes.find((change) => change.path === "a file [one].txt")!);
  changes = await getWorktreeChanges(cwd);
  assert.equal(changes.find((change) => change.path === "a file [one].txt")?.staged, true);
});

test("restore separates staged and working sides and protects untracked deletion", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  commitFile(cwd, "tracked.txt", "base\n", "base");
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "index\n", "utf8");
  git(cwd, ["add", "tracked.txt"]);
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "working\n", "utf8");
  fs.writeFileSync(path.join(cwd, "untracked.txt"), "new\n", "utf8");

  let changes = await getWorktreeChanges(cwd);
  const tracked = changes.find((change) => change.path === "tracked.txt")!;
  await restoreWorktreeChange(cwd, tracked, "working");
  assert.equal(fs.readFileSync(path.join(cwd, "tracked.txt"), "utf8").replace(/\r\n/g, "\n"), "index\n");
  changes = await getWorktreeChanges(cwd);
  await restoreWorktreeChange(cwd, changes.find((change) => change.path === "tracked.txt")!, "staged");
  assert.equal(git(cwd, ["show", ":tracked.txt"]), "base");
  // Restoring the index must not silently overwrite the still-present working
  // content. This is the staged-side contract used by the SCM restore action.
  assert.equal(fs.readFileSync(path.join(cwd, "tracked.txt"), "utf8").replace(/\r\n/g, "\n"), "index\n");

  changes = await getWorktreeChanges(cwd);
  const untracked = changes.find((change) => change.path === "untracked.txt")!;
  await assert.rejects(() => restoreWorktreeChange(cwd, untracked, "working"), /未跟踪文件不会自动删除/);
  await deleteUntrackedWorktreeChange(cwd, untracked);
  assert.equal(fs.existsSync(path.join(cwd, "untracked.txt")), false);
});

test("single-file stage updates an RM record through only its working-side path", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  commitFile(cwd, "old.txt", "base\n", "base");
  commitFile(cwd, "unrelated.txt", "base\n", "unrelated base");
  git(cwd, ["mv", "old.txt", "new.txt"]);
  fs.writeFileSync(path.join(cwd, "new.txt"), "renamed and modified\n", "utf8");
  fs.writeFileSync(path.join(cwd, "unrelated.txt"), "still working only\n", "utf8");

  let changes = await getWorktreeChanges(cwd);
  const renamed = changes.find((change) => change.path === "new.txt")!;
  assert.deepEqual(
    { staged: renamed.staged, unstaged: renamed.unstaged, index: renamed.indexKind, original: renamed.originalPath },
    { staged: true, unstaged: true, index: "rename", original: "old.txt" }
  );
  await stageWorktreeChange(cwd, renamed);

  changes = await getWorktreeChanges(cwd);
  const after = changes.find((change) => change.path === "new.txt")!;
  assert.deepEqual({ staged: after.staged, unstaged: after.unstaged }, { staged: true, unstaged: false });
  // Git may subsequently classify the fully staged change as add/delete rather
  // than rename; the contract is that the working side is gone and its content
  // is in the index without touching unrelated entries.
  assert.equal(git(cwd, ["show", ":new.txt"]), "renamed and modified");
  assert.equal(changes.find((change) => change.path === "unrelated.txt")?.unstaged, true, "does not stage unrelated changes");
});
