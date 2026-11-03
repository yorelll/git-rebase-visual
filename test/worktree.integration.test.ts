import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as path from "path";
import {
  stashApplyIndexBySha,
  stashList,
  stashPush,
  stashPushKeepIndex,
  stashRestoreForAmend,
  stashRestoreWorktreeAfterAmend,
} from "../src/git/worktree";
import {
  discardAllWorktreeChanges,
  getWorktreeChanges,
  restoreWorktreeChange,
  unstageAllWorktreeChanges,
} from "../src/git/worktreeChanges";
import { createRepo, commitFile, git, gitExit, removeRepo } from "./helpers/gitTestRepo";

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

/**
 * N-4: every site that hands a Git-derived path back to Git as a pathspec must
 * be pinned by a test whose decoy differs from the target in content.
 *
 * The reason a plausible-looking decoy can be vacuous: a wrong-glob write that
 * lands *identical* bytes is indistinguishable from never touching the file. So
 * each fixture below gives the decoy a value that the target never has, at the
 * exact step the call runs, and asserts the decoy still holds that value
 * afterwards. Removing `env: LITERAL_PATHSPECS` from the corresponding call
 * makes the assertion fail.
 *
 * Covered here (the four sites the earlier tests missed):
 *   1. `worktree.ts` restoreUntrackedHalf: `checkout <stash>^3 -- <path>` and
 *      the `reset -q -- <path>` that follows it
 *   2. `worktree.ts` restoreWorktreeHalf: `restore --source=<stash> --worktree`
 *   3. `worktreeChanges.ts` single-file worktree restore
 *   4. `worktreeChanges.ts` bulk worktree restore and bulk unstage
 *
 * Appendix A of `docs/release-notes/0.8.2.md` records which site each test pins.
 */
test("an untracked glob-named path is restored from ^3 without checking out its decoy", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  git(cwd, ["config", "core.autocrlf", "false"]);
  commitFile(cwd, "base.txt", "base\n", "base");

  // Both paths are untracked, so both live in the stash's `^3` tree. A glob
  // `checkout <stash>^3 -- br[1].txt` also materializes `br1.txt`, which leaves
  // the decoy's *stash* bytes on disk and, worse, in the index until the reset
  // removes them.
  fs.writeFileSync(path.join(cwd, "br[1].txt"), "TARGET-UNTRACKED\n", "utf8");
  fs.writeFileSync(path.join(cwd, "br1.txt"), "DECOY-UNTRACKED\n", "utf8");
  const sha = await stashPush(cwd);
  assert.ok(sha, "the snapshot stash was created");
  assert.equal(git(cwd, ["status", "--porcelain"]), "", "the snapshot emptied the worktree");

  // The decoy must be *skipped by the loop* for a glob match to be visible:
  // `restoreUntrackedHalf` iterates every `^3` path, so a decoy that is left
  // untracked would legitimately be restored by its own iteration with exactly
  // these bytes — indistinguishable from a glob match. Giving it an index entry
  // makes the loop skip it (it is "tracked again"), so only a glob can touch it.
  fs.writeFileSync(path.join(cwd, "br1.txt"), "DECOY-STAGED\n", "utf8");
  git(cwd, ["add", "br1.txt"]);
  assert.equal(git(cwd, ["show", ":br1.txt"]), "DECOY-STAGED", "the decoy has its own index entry");

  // `stashRestoreForAmend` runs the staged half (empty) then the untracked half.
  const result = await stashRestoreForAmend(cwd, sha!);
  assert.equal(result.ok, true, `the restore succeeded: ${result.message}`);

  assert.equal(
    fs.readFileSync(path.join(cwd, "br[1].txt"), "utf8").replace(/\r\n/g, "\n"),
    "TARGET-UNTRACKED\n",
    "the glob-named untracked file came back with its own content"
  );
  // The decoy is the decisive assertion: a glob `checkout <sha>^3` rewrites both
  // its worktree bytes and its index entry with the stash value.
  assert.equal(
    fs.readFileSync(path.join(cwd, "br1.txt"), "utf8").replace(/\r\n/g, "\n"),
    "DECOY-STAGED\n",
    "the decoy keeps the worktree content it had, so no glob checkout ran"
  );
  assert.equal(
    git(cwd, ["show", ":br1.txt"]),
    "DECOY-STAGED",
    "and its index entry is not rewritten to the stash's DECOY-UNTRACKED"
  );
  // The target itself must be untracked again: its own `reset` ran.
  assert.equal(git(cwd, ["ls-files"]).includes("br[1].txt"), false, "the target is not left staged");
  assert.equal(
    fs.readFileSync(path.join(cwd, "br[1].txt"), "utf8").replace(/\r\n/g, "\n"),
    "TARGET-UNTRACKED\n",
    "the target's content came back correctly"
  );
});

test("the worktree half restores a glob-named path without reverting its decoy", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  git(cwd, ["config", "core.autocrlf", "false"]);
  commitFile(cwd, "base.txt", "base\n", "base");
  commitFile(cwd, "br[1].txt", "TARGET-V1\n", "target base");
  commitFile(cwd, "br1.txt", "DECOY-V1\n", "decoy base");

  // Only the target carries a worktree edit, so the snapshot's worktree half is
  // exactly one path: `restoreWorktreeHalf` restores `^1..<stash>` and a literal
  // pathspec must leave the decoy alone. The decoy then gets a *later* edit that
  // exists in no tree — a glob match reverts it to DECOY-V1, a literal one keeps
  // DECOY-NOW. (Giving the decoy a worktree edit at stash time would put it in
  // the snapshot too, and restoring it would be correct, not a bug.)
  fs.writeFileSync(path.join(cwd, "br[1].txt"), "TARGET-WT\n", "utf8");
  const sha = await stashPush(cwd);
  assert.ok(sha, "the snapshot stash was created");
  fs.writeFileSync(path.join(cwd, "br1.txt"), "DECOY-NOW\n", "utf8");

  // The amend phase skips the worktree half; this is the post-amend phase.
  const result = await stashRestoreWorktreeAfterAmend(cwd, sha!);
  assert.equal(result.ok, true, `the worktree half restored: ${result.message}`);

  assert.equal(
    fs.readFileSync(path.join(cwd, "br[1].txt"), "utf8").replace(/\r\n/g, "\n"),
    "TARGET-WT\n",
    "the targeted path got its snapshot content back"
  );
  assert.equal(
    fs.readFileSync(path.join(cwd, "br1.txt"), "utf8").replace(/\r\n/g, "\n"),
    "DECOY-NOW\n",
    "the decoy keeps the content it had at restore time; a glob match would revert it to DECOY-V1"
  );
});

test("single-file and bulk worktree restoration treat glob names literally", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  git(cwd, ["config", "core.autocrlf", "false"]);
  commitFile(cwd, "br[1].txt", "TARGET-V1\n", "target base");
  commitFile(cwd, "br1.txt", "DECOY-V1\n", "decoy base");

  // Single-file worktree restore (`restore --worktree -- <one path>`):
  // the decoy has a worktree edit distinct from HEAD, the target an edit of its
  // own. A glob match reverts the decoy too, back to DECOY-V1.
  fs.writeFileSync(path.join(cwd, "br[1].txt"), "TARGET-WT\n", "utf8");
  fs.writeFileSync(path.join(cwd, "br1.txt"), "DECOY-WT\n", "utf8");
  let changes = await getWorktreeChanges(cwd);
  await restoreWorktreeChange(cwd, changes.find((change) => change.path === "br[1].txt")!, "working");
  assert.equal(
    fs.readFileSync(path.join(cwd, "br[1].txt"), "utf8").replace(/\r\n/g, "\n"),
    "TARGET-V1\n",
    "the targeted path was reverted"
  );
  assert.equal(
    fs.readFileSync(path.join(cwd, "br1.txt"), "utf8").replace(/\r\n/g, "\n"),
    "DECOY-WT\n",
    "the decoy's worktree edit survived the single-file restore"
  );

  // Bulk worktree restore (`restore --worktree -- <paths...>`): the caller
  // supplies the list, so only the target is passed. The decoy is staged with
  // one value and edited to another, so a glob match would write the *index*
  // value into its worktree and the difference is visible.
  fs.writeFileSync(path.join(cwd, "br1.txt"), "DECOY-STAGED\n", "utf8");
  git(cwd, ["add", "br1.txt"]);
  fs.writeFileSync(path.join(cwd, "br1.txt"), "DECOY-WT2\n", "utf8");
  fs.writeFileSync(path.join(cwd, "br[1].txt"), "TARGET-WT2\n", "utf8");
  const onlyTarget = (await getWorktreeChanges(cwd)).filter((change) => change.path === "br[1].txt");
  assert.equal(onlyTarget.length, 1, "the caller passes exactly one path to the bulk operation");
  await discardAllWorktreeChanges(cwd, onlyTarget);
  assert.equal(
    fs.readFileSync(path.join(cwd, "br[1].txt"), "utf8").replace(/\r\n/g, "\n"),
    "TARGET-V1\n",
    "the targeted path was reverted to HEAD"
  );
  assert.equal(
    fs.readFileSync(path.join(cwd, "br1.txt"), "utf8").replace(/\r\n/g, "\n"),
    "DECOY-WT2\n",
    "the decoy's worktree edit survives: it was not in the list, so a glob match is the only way it could change"
  );
  assert.equal(
    git(cwd, ["show", ":br1.txt"]),
    "DECOY-STAGED",
    "and its index entry is untouched by the worktree restore"
  );
});

test("bulk unstage treats glob names literally and keeps the decoy's entry", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  git(cwd, ["config", "core.autocrlf", "false"]);
  commitFile(cwd, "base.txt", "base\n", "base");
  // Both paths are *new* files staged for the first time. `restore --staged`
  // drops an entry that has no HEAD counterpart entirely, so a glob match makes
  // the decoy's index entry vanish — observable, unlike a staged modification of
  // a tracked file, whose entry would merely revert to its HEAD value (identical
  // to what the untouched index already holds).
  fs.writeFileSync(path.join(cwd, "br[1].txt"), "TARGET-STAGED\n", "utf8");
  fs.writeFileSync(path.join(cwd, "br1.txt"), "DECOY-STAGED\n", "utf8");
  git(cwd, ["add", "br[1].txt", "br1.txt"]);
  assert.equal(git(cwd, ["show", ":br[1].txt"]), "TARGET-STAGED");
  assert.equal(git(cwd, ["show", ":br1.txt"]), "DECOY-STAGED", "the decoy has a staged entry to lose");

  const onlyTarget = (await getWorktreeChanges(cwd)).filter((change) => change.path === "br[1].txt");
  assert.equal(onlyTarget.length, 1, "the caller passes exactly one path to the bulk unstage");
  await unstageAllWorktreeChanges(cwd, onlyTarget);

  assert.notEqual(
    0,
    gitExit(cwd, ["cat-file", "-e", ":br[1].txt"]),
    "the targeted new file left the index entirely"
  );
  assert.equal(git(cwd, ["show", ":br1.txt"]), "DECOY-STAGED", "the decoy's index entry survives");
  assert.equal(
    fs.readFileSync(path.join(cwd, "br[1].txt"), "utf8").replace(/\r\n/g, "\n"),
    "TARGET-STAGED\n",
    "and the target's worktree content is retained"
  );
  assert.equal(
    fs.readFileSync(path.join(cwd, "br1.txt"), "utf8").replace(/\r\n/g, "\n"),
    "DECOY-STAGED\n",
    "the decoy's worktree content is untouched"
  );
});
