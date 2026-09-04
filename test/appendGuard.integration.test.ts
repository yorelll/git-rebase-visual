import assert from "node:assert/strict";
import test from "node:test";
import { isAncestor, patchId, clearPatchIdCache } from "../src/git/commitLog";
import { createRepo, commitFile, git, removeRepo } from "./helpers/gitTestRepo";

// The provider's append-to-commit path hard-blocks two cases before it runs a
// rebase: (1) the target commit is locked, and (2) the target commit is already
// on the local upstream. These integration tests exercise the exact git-level
// primitives that guard those branches.

test("append guard: a target already on the local upstream is not amendable via the guard primitive", async (t) => {
  const cwd = createRepo();
  t.after(() => {
    clearPatchIdCache();
    removeRepo(cwd);
  });
  const base = commitFile(cwd, "base.txt", "base\n", "base");
  const target = commitFile(cwd, "target.txt", "target\n", "target");
  commitFile(cwd, "tip.txt", "tip\n", "tip");

  // Simulate a local upstream that already contains the target commit: the
  // provider treats `@{upstream}` as already-pushed when it is an ancestor.
  // Use a resolvable local ref (like @{upstream}) rather than a raw
  // refs/heads path, which `merge-base --is-ancestor` cannot dereference.
  git(cwd, ["update-ref", "refs/heads/upstream-branch", target]);

  // The commit is already on the "upstream" — the guard must reject appending.
  assert.equal(await isAncestor(cwd, target, "upstream-branch"), true);
  // And amending the guarded commit then rebase-replaying would rewrite shared
  // history: verify the rewritten commit would leave the upstream branch
  // pointing at the old target, i.e. it no longer contains the target.
  git(cwd, ["rebase", "--onto", `${target}^`, target, "HEAD"]);
  const newTip = git(cwd, ["rev-parse", "HEAD"]);
  assert.equal(
    await isAncestor(cwd, "upstream-branch", newTip),
    false // upstream still points at the old (dropped) target
  );
  assert.equal(await isAncestor(cwd, "upstream-branch", "HEAD"), false);
  void base;
});

test("append guard: a locked target keeps its patch-id across a rewritten clone", async (t) => {
  const cwd = createRepo();
  t.after(() => {
    clearPatchIdCache();
    removeRepo(cwd);
  });
  commitFile(cwd, "base.txt", "base\n", "base");
  const target = commitFile(cwd, "one.txt", "one\n", "target");
  commitFile(cwd, "two.txt", "two\n", "tip");

  // The provider rejects appending after it locks; its `isLocked` check uses
  // exactly this patch-id. Assert the identity stays stable so an "unlock by
  // patch-id" would not accidentally unlock a rewritten clone. Rewrite the
  // target with `commit-tree` using the same tree but a different commit
  // object (new hash, identical diff) — deterministic, no interactive rebase.
  const pid = await patchId(cwd, target);
  assert.ok(pid);
  const parent = git(cwd, ["rev-parse", `${target}^`]);
  const clone = git(cwd, [
    "commit-tree",
    `${target}^{tree}`,
    "-p",
    parent,
    "-m",
    "rewritten clone",
  ]);
  assert.notEqual(clone, target);
  // Same content diff -> same patch-id (the lock identity).
  assert.equal(await patchId(cwd, clone), pid);
});
