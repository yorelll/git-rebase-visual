import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as path from "path";
import { applyCommitBinaryStatus, commitDiffPlan, parseCommitChangedFiles } from "../src/ui/commitDiffState";
import { commitDiffSpec } from "../src/ui/gitDiffRequestState";
import { createRepo, commitFile, git, removeRepo } from "./helpers/gitTestRepo";

async function planFor(cwd: string, commit: string) {
  const parents = git(cwd, ["show", "-s", "--format=%P", commit]).split(/\s+/).filter(Boolean);
  const names = git(cwd, ["diff-tree", "--no-commit-id", "--name-status", "-z", "-M", "--root", "-r", commit]);
  const numstat = git(cwd, ["diff-tree", "--no-commit-id", "--numstat", "-z", "-M", "--root", "-r", commit]);
  return commitDiffPlan(commit, parents, applyCommitBinaryStatus(parseCommitChangedFiles(names), numstat));
}

test("commit diff planner resolves root, add/delete, rename, multi-file selection data, and binary fallback", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));

  fs.writeFileSync(path.join(cwd, "root.txt"), "root\n", "utf8");
  git(cwd, ["add", "root.txt"]);
  git(cwd, ["commit", "-qm", "root"]);
  const root = git(cwd, ["rev-parse", "HEAD"]);
  const rootPlan = await planFor(cwd, root);
  assert.equal(rootPlan.parent, undefined);
  assert.deepEqual(commitDiffSpec(rootPlan.parent, root, rootPlan.files[0]!), {
    left: { version: "empty", filePath: "root.txt" },
    right: { version: "commit", commit: root, filePath: "root.txt" },
    title: "Add (parent ↔ commit): root.txt",
  });

  fs.writeFileSync(path.join(cwd, "added.txt"), "added\n", "utf8");
  fs.unlinkSync(path.join(cwd, "root.txt"));
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-qm", "add and delete"]);
  const addDelete = await planFor(cwd, git(cwd, ["rev-parse", "HEAD"]));
  assert.equal(addDelete.files.length, 2, "multi-file commits retain file-level choices");
  const add = addDelete.files.find((file) => file.kind === "add")!;
  const deleted = addDelete.files.find((file) => file.kind === "delete")!;
  assert.equal(commitDiffSpec(addDelete.parent, addDelete.commit, add).left.version, "empty");
  assert.equal(commitDiffSpec(addDelete.parent, addDelete.commit, deleted).right.version, "empty");

  git(cwd, ["mv", "added.txt", "renamed.txt"]);
  git(cwd, ["commit", "-qm", "rename"]);
  const renamePlan = await planFor(cwd, git(cwd, ["rev-parse", "HEAD"]));
  const rename = renamePlan.files[0]!;
  assert.deepEqual({ kind: rename.kind, originalPath: rename.originalPath, path: rename.path }, {
    kind: "rename", originalPath: "added.txt", path: "renamed.txt",
  });
  const renameSpec = commitDiffSpec(renamePlan.parent, renamePlan.commit, rename);
  assert.equal(renameSpec.left.filePath, "added.txt");
  assert.equal(renameSpec.right.filePath, "renamed.txt");

  fs.writeFileSync(path.join(cwd, "asset.bin"), Buffer.from([0, 255, 0, 1]));
  git(cwd, ["add", "asset.bin"]);
  git(cwd, ["commit", "-qm", "binary"]);
  const binaryPlan = await planFor(cwd, git(cwd, ["rev-parse", "HEAD"]));
  const binary = binaryPlan.files.find((file) => file.path === "asset.bin")!;
  assert.equal(binary.binary, true);
  assert.match(commitDiffSpec(binaryPlan.parent, binaryPlan.commit, binary).fallbackReason ?? "", /二进制文件/);
});

test("commit diff planner retains nested paths from recursive Git output", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  fs.mkdirSync(path.join(cwd, "nested"));
  fs.writeFileSync(path.join(cwd, "nested", "entry.txt"), "one\n", "utf8");
  git(cwd, ["add", "nested/entry.txt"]);
  git(cwd, ["commit", "-qm", "nested root"]);
  const rootPlan = await planFor(cwd, git(cwd, ["rev-parse", "HEAD"]));
  assert.deepEqual(rootPlan.files, [{ kind: "add", path: "nested/entry.txt", binary: false }]);

  fs.writeFileSync(path.join(cwd, "nested", "entry.txt"), "two\n", "utf8");
  git(cwd, ["add", "nested/entry.txt"]);
  git(cwd, ["commit", "-qm", "nested modify"]);
  const modifyPlan = await planFor(cwd, git(cwd, ["rev-parse", "HEAD"]));
  assert.deepEqual(modifyPlan.files, [{ kind: "modify", path: "nested/entry.txt", binary: false }]);
});

test("commit diff planner rejects ambiguous merge parents", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  const first = commitFile(cwd, "one.txt", "one\n", "first");
  assert.match(first, /^[0-9a-f]{40}$/);
  const plan = commitDiffPlan("a".repeat(40), ["b".repeat(40), "c".repeat(40)], [{ kind: "modify", path: "one.txt", binary: false }]);
  assert.match(plan.fallbackReason ?? "", /多个父版本/);
});
