import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as path from "path";
import {
  continueRebase,
  resolveBase,
  executeRebase,
} from "../src/git/rebaseEngine";
import { isRebaseInProgress } from "../src/git/commitLog";
import {
  reconcilePendingAppend,
  reconcilePendingStash,
  recoveryCommands,
  resetDecision,
  stagedSnapshotInHead,
  stashNameForSha,
  stashPresence,
  stashShas,
} from "../src/git/pendingRecovery";
import {
  GitInvocationLog,
  runGit,
  setGitInvocationObserver,
} from "../src/git/gitRunner";
import {
  createdStash,
  dropVerdict,
  readStashList,
  stashRestoreWorktreeAfterAmend,
  stashApplyIndexBySha,
  stashPush,
  stashPushKeepIndex,
  stashRemoveBySha,
  stashRestoreForAmend,
  stashShasForComparison,
  undoWrongDrop,
} from "../src/git/worktree";
import {
  cleanupRepo,
  commitFile,
  createRepo,
  git,
  removeRepo,
} from "./helpers/gitTestRepo";
import {
  cleanup,
  pushUserStash,
  runOneCommandPerRepo,
  stashShaSet,
  stashSnapshot,
} from "./helpers/pendingRecoveryFixtures";

/**
 * Residual content and own-entry removal: restoring what the snapshot held beyond HEAD, and proving which stash entry was dropped.
 *
 * Split out of `pendingRecovery.integration.test.ts` (no test was added, removed,
 * or rewritten). These run under Node's per-file scheduling, so each one owns its
 * repositories and shares nothing at module level.
 */

test("a residual path holding newer content keeps the record instead of being overwritten", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  const first = commitFile(cwd, "first.txt", "first\n", "first");
  const target = commitFile(cwd, "target.txt", "target\n", "target");
  const { sha } = await stashSnapshot(cwd);

  const stopped = await executeRebase(cwd, {
    onto: await resolveBase(cwd, first),
    items: [
      { hash: first, action: "pick", subject: "first" },
      { hash: target, action: "edit", subject: "target" },
    ],
  });
  assert.equal(stopped.stopped, true);
  assert.equal((await stashApplyIndexBySha(cwd, sha)).ok, true);
  git(cwd, ["commit", "--amend", "--no-edit"]);

  // The untracked file is gone, but a different file now occupies its path.
  // Reconstructing the snapshot there would silently discard that newer work,
  // so the record must be kept and the path left untouched.
  fs.rmSync(path.join(cwd, "untracked.txt"));
  fs.writeFileSync(path.join(cwd, "untracked.txt"), "newer user work\n", "utf8");

  const outcome = await reconcilePendingAppend(cwd, { changeStash: sha, targetHash: target, amended: true });
  assert.equal(outcome.kind, "pending", "an overwrite is refused");
  assert.match(outcome.kind === "pending" ? outcome.reason : "", /untracked\.txt/);
  assert.equal(
    fs.readFileSync(path.join(cwd, "untracked.txt"), "utf8").replace(/\r\n/g, "\n"),
    "newer user work\n",
    "the newer content is not overwritten"
  );
  assert.equal(git(cwd, ["stash", "list"]).includes("stash@{0}"), true, "the recovery copy is kept");
});

test("a renamed directory keeps the record and the stash rather than reporting a resolution", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  fs.mkdirSync(path.join(cwd, "old"));
  commitFile(cwd, "old/shared.txt", "body\n", "base");
  const target = commitFile(cwd, "other.txt", "other\n", "target");

  fs.writeFileSync(path.join(cwd, "old", "shared.txt"), "body\nappended\n", "utf8");
  git(cwd, ["add", "old/shared.txt"]);
  const sha = await stashPush(cwd);
  assert.ok(sha, "the snapshot was created");

  const applied = await stashApplyIndexBySha(cwd, sha);
  assert.equal(applied.ok, true);
  git(cwd, ["commit", "--amend", "--no-edit"]);
  git(cwd, ["mv", "old", "new"]);
  git(cwd, ["commit", "-qm", "move the directory"]);
  assert.equal(fs.existsSync(path.join(cwd, "old", "shared.txt")), false, "the old path is gone");
  assert.equal(
    git(cwd, ["rev-parse", "HEAD:new/shared.txt"]),
    git(cwd, ["rev-parse", `${sha}^2:old/shared.txt`]),
    "the appended content landed under the new path"
  );

  // The snapshot's path no longer exists at HEAD, so the tree comparison cannot
  // confirm it. That is exactly the "keep the record" outcome now: no rename
  // inference is attempted, and nothing is deleted.
  const committed = await stagedSnapshotInHead(cwd, sha);
  assert.equal(committed.committed, false, "a moved path is not silently treated as the same path");
  const outcome = await reconcilePendingAppend(cwd, { changeStash: sha, targetHash: target, amended: true });
  assert.equal(outcome.kind, "pending");
  assert.equal(git(cwd, ["stash", "list"]).includes("stash@{0}"), true, "the stash survives");
});

test("a residual tracked path whose newer content is already committed is never overwritten", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "shared.txt", "shared ORIGINAL content\n", "shared");
  const target = commitFile(cwd, "target.txt", "target\n", "target");

  // The tracked residual: a staged change plus a worktree-only edit on the same
  // file, so `stash^2..stash` carries content the amended commit cannot contain.
  fs.writeFileSync(path.join(cwd, "shared.txt"), "shared STAGED edit\n", "utf8");
  git(cwd, ["add", "shared.txt"]);
  fs.writeFileSync(path.join(cwd, "shared.txt"), "shared WORKTREE edit\n", "utf8");
  const sha = await stashPush(cwd);
  assert.ok(sha, "the snapshot was created");
  assert.notEqual(
    git(cwd, ["rev-parse", `${sha}^2:shared.txt`]),
    git(cwd, ["rev-parse", `${sha}:shared.txt`]),
    "the snapshot has a worktree-only change"
  );

  // The append: restore the snapshot's index, amend the target with it. The
  // recorded target SHA is now rewritten.
  assert.equal((await stashApplyIndexBySha(cwd, sha)).ok, true);
  git(cwd, ["commit", "--amend", "--no-edit"]);
  assert.notEqual(git(cwd, ["rev-parse", "HEAD"]), target, "the recorded target was rewritten");

  // The user then commits newer content and leaves the worktree clean, so
  // worktree == HEAD exactly. A HEAD-relative "clean" check reads that as
  // "untouched since the snapshot" and overwrites it with the stale residual.
  fs.writeFileSync(path.join(cwd, "shared.txt"), "shared LATER COMMIT content\n", "utf8");
  git(cwd, ["add", "shared.txt"]);
  git(cwd, ["commit", "-q", "-m", "newer tracked content"]);
  assert.equal(git(cwd, ["status", "--porcelain"]), "", "the worktree matches HEAD exactly");

  const outcome = await reconcilePendingAppend(cwd, { changeStash: sha, targetHash: target, amended: true });
  assert.equal(outcome.kind, "pending", "an overwrite of committed newer content is refused");
  assert.match(outcome.kind === "pending" ? outcome.reason : "", /shared\.txt/);
  assert.equal(
    fs.readFileSync(path.join(cwd, "shared.txt"), "utf8").replace(/\r\n/g, "\n"),
    "shared LATER COMMIT content\n",
    "the newer committed content is not overwritten"
  );
  assert.equal(git(cwd, ["stash", "list"]).includes("stash@{0}"), true, "the recovery copy is kept");
});

test("a full recovery pass removes only its own entries, never the user's", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  const first = commitFile(cwd, "first.txt", "first\n", "first");
  commitFile(cwd, "keep.txt", "keep\n", "keep");
  const target = commitFile(cwd, "target.txt", "target\n", "target");
  // A stash the user made. It must be in the same sha set before and after.
  const theirs = pushUserStash(cwd, "theirs");

  // Both halves of an append, so the pass exercises both removal sites: the
  // worktree (keep-index) stash and the change stash.
  fs.writeFileSync(path.join(cwd, "keep.txt"), "keep WORKTREE\n", "utf8");
  const unstagedStash = await stashPushKeepIndex(cwd);
  assert.ok(unstagedStash, "the worktree stash was created");
  fs.writeFileSync(path.join(cwd, "keep.txt"), "keep\n", "utf8");

  fs.writeFileSync(path.join(cwd, "staged.txt"), "staged\n", "utf8");
  git(cwd, ["add", "staged.txt"]);
  const changeStash = await stashPush(cwd);
  assert.ok(changeStash, "the change stash was created");

  const stopped = await executeRebase(cwd, {
    onto: await resolveBase(cwd, first),
    items: [
      { hash: first, action: "pick", subject: "first" },
      { hash: target, action: "edit", subject: "target" },
    ],
  });
  assert.equal(stopped.stopped, true);
  assert.equal((await stashApplyIndexBySha(cwd, changeStash)).ok, true);
  git(cwd, ["commit", "--amend", "--no-edit"]);

  // Observe every Git invocation made while the pass runs. `runGit` reports
  // through a process-wide observer, so this sees the real argv.
  const observed: GitInvocationLog[] = [];
  setGitInvocationObserver((entry) => observed.push(entry));
  t.after(() => setGitInvocationObserver(undefined));

  const outcome = await reconcilePendingAppend(cwd, {
    changeStash,
    targetHash: target,
    amended: true,
    unstagedStash,
  });
  assert.equal(outcome.kind, "resolved", "both halves are accounted for");
  assert.ok(observed.length > 0, "the observer really saw the pass");

  // `pop` is never used and `clear` never exists: removal is a slot-addressed
  // `drop` after verification, so the only destructive verb that may appear is
  // `drop`, once per entry this transaction owns.
  const forbidden = observed.filter(
    (entry) => entry.args[0] === "stash" && (entry.args[1] === "pop" || entry.args[1] === "clear")
  );
  assert.deepEqual(
    forbidden.map((entry) => entry.args.join(" ")),
    [],
    "recovery never pops or clears a stash"
  );
  const drops = observed.filter((entry) => entry.args[0] === "stash" && entry.args[1] === "drop");
  assert.equal(drops.length, 2, "exactly the two entries this transaction owns are dropped");

  // The worktree-only content is back, and the sha set is exactly what the user
  // had before the plugin created anything.
  assert.equal(
    fs.readFileSync(path.join(cwd, "keep.txt"), "utf8").replace(/\r\n/g, "\n"),
    "keep WORKTREE\n",
    "the worktree-only content was restored"
  );
  assert.deepEqual(stashShaSet(cwd), [theirs].sort(), "only the user's own entry remains");
  const removals = outcome.stashRemoved ?? [];
  assert.deepEqual(
    removals.map((removal) => removal.sha).sort(),
    [changeStash, unstagedStash].sort(),
    "both removals name the transaction's own entries"
  );
  assert.equal(
    removals.some((removal) => removal.sha === theirs),
    false,
    "the user's entry is never part of a removal"
  );
});

test("a keep-index stash rebased after the amend restores its residual instead of reporting a false conflict", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  const first = commitFile(cwd, "first.txt", "first\n", "first");
  const target = commitFile(cwd, "target.txt", "target\n", "target");
  commitFile(cwd, "later.txt", "later\n", "later");

  // The user's shape: a staged append plus worktree-only edits on a tracked file
  // the edit-stop commit owns. That is the shape that rebases cleanly and then
  // leaves the worktree at the committed content.
  fs.writeFileSync(path.join(cwd, "append.txt"), "append\n", "utf8");
  git(cwd, ["add", "append.txt"]);
  fs.writeFileSync(path.join(cwd, "first.txt"), "first WORKTREE\n", "utf8");
  fs.writeFileSync(path.join(cwd, "residual.txt"), "residual\n", "utf8");
  const changeStash = await stashPush(cwd);
  assert.ok(changeStash, "the pre-append snapshot was created");

  const stopped = await executeRebase(cwd, {
    onto: await resolveBase(cwd, first),
    items: [
      { hash: first, action: "pick", subject: "first" },
      { hash: target, action: "edit", subject: "target" },
    ],
  });
  assert.equal(stopped.stopped, true);
  assert.equal((await stashApplyIndexBySha(cwd, changeStash)).ok, true);
  git(cwd, ["commit", "--amend", "--no-edit"]);
  const unstagedStash = await stashPushKeepIndex(cwd);
  assert.ok(unstagedStash, "the keep-index worktree stash was created");

  // `rebase --continue` replays the commit that follows the edited target. That
  // replay rewrites the index and puts the follow-up commit's files in the
  // worktree, so after it the pre-rebase residual paths no longer match the
  // snapshot even though the residual itself was never in the amended commit.
  const continued = await continueRebase(cwd);
  assert.equal(continued.ok, true, `rebase --continue failed: ${continued.message}`);
  assert.equal(await isRebaseInProgress(cwd), false);

  const outcome = await reconcilePendingAppend(cwd, {
    changeStash,
    unstagedStash,
    targetHash: target,
    amended: true,
  });

  assert.notEqual(outcome.kind, "pending", "the residual was restorable, so no warning is warranted");
  assert.equal(
    fs.readFileSync(path.join(cwd, "first.txt"), "utf8").replace(/\r\n/g, "\n"),
    "first WORKTREE\n",
    "the worktree-only edit is back"
  );
  assert.equal(fs.readFileSync(path.join(cwd, "residual.txt"), "utf8").replace(/\r\n/g, "\n"), "residual\n");
  // Both halves were restored for real, so both of this transaction's entries
  // are removed and the list is empty again — the two records cannot outlive
  // the transaction that owned them.
  assert.deepEqual(stashShaSet(cwd), [], "both of this transaction's entries are gone");
  assert.equal(
    outcome.kind === "restored" ? (outcome.stashRemoved ?? []).length : 0,
    2,
    "and both removals are reported"
  );
});

test("a residual path with glob characters restores literally and never overwrites the decoy", async (t) => {
  const cwd = createRepo();
  t.after(() => cleanupRepo(cwd));
  git(cwd, ["config", "core.autocrlf", "false"]);
  const first = commitFile(cwd, "first.txt", "first\n", "first");
  commitFile(cwd, "e[1].txt", "ORIGINAL\n", "glob file");
  commitFile(cwd, "e1.txt", "DECOY-ORIGINAL\n", "decoy");

  // A worktree-only edit on the glob-named file, so it lands in `^2..stash` and
  // the residual worktree restore is the call that has to match it literally.
  fs.writeFileSync(path.join(cwd, "e[1].txt"), "SNAPSHOT-WORKTREE\n", "utf8");
  const sha = await stashPush(cwd);
  assert.ok(sha);

  const stopped = await executeRebase(cwd, {
    onto: await resolveBase(cwd, first),
    items: [{ hash: first, action: "edit", subject: "first" }],
  });
  assert.equal(stopped.stopped, true);

  // Newer user content sits at the path a glob match would hit.
  fs.writeFileSync(path.join(cwd, "e1.txt"), "USER-NEWER\n", "utf8");

  const outcome = await reconcilePendingAppend(cwd, { changeStash: sha!, targetHash: first, amended: false });
  assert.equal(
    fs.readFileSync(path.join(cwd, "e1.txt"), "utf8").replace(/\r\n/g, "\n"),
    "USER-NEWER\n",
    `the decoy must never be overwritten (outcome ${outcome.kind}: ${(outcome as { reason?: string }).reason ?? ""})`
  );
});

/**
 * P2-1: the banner must lead with a command that can actually run.
 *
 * When the guard keeps an append record pending with `index: present`, the
 * staged half is already in the index, so `git stash apply --index` fails with
 * "already exists in index ... Try without --index" (exit 1). The banner used to
 * offer that command first, at the exact moment the user needed a working one.
 * The fix builds the list from the observed presence; this test executes the
 * first offered command against the real state instead of asserting strings.
 */

test("a conflicting worktree restore never removes the stash it failed to apply", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  const first = commitFile(cwd, "first.txt", "first\n", "first");
  commitFile(cwd, "keep.txt", "keep\n", "keep");
  const target = commitFile(cwd, "target.txt", "target\n", "target");

  // A keep-index worktree stash whose content is later contradicted in the
  // worktree: `apply` cannot reproduce it. The file is tracked in the pick so
  // the conflicting local edit blocks `apply` without blocking `rebase --abort`.
  fs.writeFileSync(path.join(cwd, "first.txt"), "first WORKTREE\n", "utf8");
  const unstagedStash = await stashPushKeepIndex(cwd);
  assert.ok(unstagedStash, "the worktree stash was created");

  fs.writeFileSync(path.join(cwd, "staged.txt"), "staged\n", "utf8");
  git(cwd, ["add", "staged.txt"]);
  const changeStash = await stashPush(cwd);
  assert.ok(changeStash, "the change stash was created");

  const stopped = await executeRebase(cwd, {
    onto: await resolveBase(cwd, first),
    items: [
      { hash: first, action: "pick", subject: "first" },
      { hash: target, action: "edit", subject: "target" },
    ],
  });
  assert.equal(stopped.stopped, true);
  assert.equal((await stashApplyIndexBySha(cwd, changeStash)).ok, true);
  git(cwd, ["commit", "--amend", "--no-edit"]);
  // Conflicting content blocks the worktree restore.
  fs.writeFileSync(path.join(cwd, "first.txt"), "conflicting\n", "utf8");

  const observed: GitInvocationLog[] = [];
  setGitInvocationObserver((entry) => observed.push(entry));
  t.after(() => setGitInvocationObserver(undefined));

  const outcome = await reconcilePendingAppend(cwd, {
    changeStash,
    targetHash: target,
    amended: true,
    unstagedStash,
  });
  assert.equal(outcome.kind, "pending", "an unappliable worktree half keeps the record");
  assert.equal(
    observed.some((entry) => entry.args[0] === "stash" && entry.args[1] === "pop"),
    false,
    "a `pop` would have deleted the copy it failed to apply"
  );
  const remaining = git(cwd, ["stash", "list", "--format=%H"]).split("\n").map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(remaining.sort(), [changeStash, unstagedStash].sort(), "both recovery copies survive");
});

/**
 * P1-2: `git restore --worktree` in the recovery path must match paths
 * literally.
 *
 * The paths come from a Git tree listing, so a name containing pathspec glob
 * characters (`*`, `?`, `[`) is a *pattern* unless `GIT_LITERAL_PATHSPECS=1` is
 * set. Without it `e[1].txt` is read as "e, or 1, .txt" and matches the tracked
 * decoy `e1.txt`, so the restore writes the snapshot's old content over newer
 * user work at that path — violating this module's promise never to overwrite
 * newer content. Both files are tracked here, and the glob-named one carries the
 * worktree-only edit, so the residual worktree restore is the call that writes.
 */

test("a stash pushed between classification and removal is refused and both entries stay", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const theirs = pushUserStash(cwd, "theirs");
  const { sha } = await stashSnapshot(cwd);
  const before = stashShaSet(cwd);
  assert.deepEqual(before, [theirs, sha].sort(), "ours on top of the user's entry");

  // A concurrent `git stash push` lands after the list lookup resolved our sha
  // to `stash@{0}` and before the occupant is re-read. `stash@{0}` is now
  // someone else's entry, so the drop must not run at all: the occupant check
  // refuses and both entries stay exactly where they were.
  const concurrent = await stashRemoveBySha(cwd, sha, {
    beforeOccupantCheck: () => {
      fs.writeFileSync(path.join(cwd, "concurrent.txt"), "concurrent\n", "utf8");
      git(cwd, ["stash", "push", "-u", "-q", "-m", "concurrent"]);
    },
  });
  assert.equal(concurrent.ok, false, "a race is never reported as a successful removal");
  assert.equal(concurrent.refused, true, "it is a refusal, never a retry");
  assert.match(concurrent.message, /no longer holds/, "and it says which slot moved");
  const after = stashShaSet(cwd);
  assert.ok(after.includes(theirs), "the user's entry is still there");
  assert.ok(after.includes(sha), "and so is ours");
  assert.equal(after.length, before.length + 1, "only the concurrent entry joined the list, nothing was removed");
});

test("a race that lands inside the drop window is undone by git stash store", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const theirs = pushUserStash(cwd, "theirs");
  const { sha } = await stashSnapshot(cwd);
  const before = stashShaSet(cwd);

  // The occupant check passes on our entry, then the concurrent push lands
  // before the drop: `stash@{0}` is now the concurrent entry, so the drop takes
  // it. This is the window a pre-check cannot close.
  const raced = await stashRemoveBySha(cwd, sha, {
    betweenCheckAndDrop: () => {
      fs.writeFileSync(path.join(cwd, "concurrent.txt"), "concurrent\n", "utf8");
      git(cwd, ["stash", "push", "-u", "-q", "-m", "concurrent"]);
    },
  });
  assert.equal(raced.ok, false, "a wrong drop is never reported as a clean removal");
  assert.equal(raced.refused, true);
  assert.match(raced.message, /已用 git stash store 原样恢复/);

  const after = stashShaSet(cwd);
  // Nothing is lost: the wrongly dropped entry is back by *sha* (its reflog
  // subject becomes the `stash store` message, which is why identity here is
  // checked by sha and never by subject), and neither the user's entry nor ours
  // was removed.
  const concurrentSha = after.find((entry) => entry !== theirs && entry !== sha);
  assert.ok(concurrentSha, "the wrongly dropped entry is listed again");
  assert.equal(after.length, before.length + 1, "one entry joined the list and none was lost");
  assert.ok(after.includes(theirs), "the user's entry is untouched");
  assert.ok(after.includes(sha), "our entry was not dropped either");
  assert.match(
    git(cwd, ["stash", "list"]),
    /git-rebase-visual restored/,
    "the restored entry carries the store message, not the original subject"
  );
});

test("a drop that takes the wrong entry puts it back intact", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const theirs = pushUserStash(cwd, "theirs");
  const { sha } = await stashSnapshot(cwd);

  // The race landing *inside* the drop window: the occupant check passes, then a
  // concurrent push shifts the slot, so `git stash drop` removes the user's entry
  // instead of ours. Reproduce it for real: drop the user's entry with plain Git,
  // capture the output Git prints, and let the verifier see it.
  const before = stashShaSet(cwd);
  assert.deepEqual(before, [theirs, sha].sort());
  const dropOutput = git(cwd, ["stash", "drop", "stash@{1}"]);
  assert.match(dropOutput, /Dropped stash@\{1\} \([0-9a-f]{7,}\)/, "Git reports the sha it dropped");
  assert.equal(stashShaSet(cwd).includes(theirs), false, "the user's entry really was dropped");

  const restored = await undoWrongDrop(cwd, sha, "stash@{1}", dropOutput, before);
  assert.equal(restored.ok, false);
  assert.equal(restored.refused, true, "a drop of the wrong entry is a refusal");
  assert.match(restored.message, /已用 git stash store 原样恢复/);
  // `stash store` is not invisible: the entry lands on top of the stack and its
  // reflog subject is rewritten, so the user who runs `git stash list` next must
  // be told to look there rather than for their original message. The wording
  // must also be precise about *which* subject: `%gs` is what changes and `%s`
  // (what `git log` shows) does not, or a user checking with the other command
  // concludes the opposite of what happened.
  assert.match(restored.message, /位于列表最上方/, "the message says where the entry went");
  assert.match(
    restored.message,
    /reflog 说明.*git-rebase-visual restored [0-9a-f]{7}/,
    "and that the reflog subject was rewritten"
  );
  assert.match(restored.message, /%gs/, "naming the reflog subject explicitly");
  assert.match(restored.message, /%s.*保持不变/, "and saying the commit subject did not change");
  const after = stashShaSet(cwd);
  assert.ok(after.includes(theirs), "the user's entry was put back by exact sha");
  assert.deepEqual(after, before, "and the list is exactly what it was");
  // The distinction the wording claims is real, not cosmetic: `%gs` is the store
  // message, `%s` is still the user's original title. Two entries are listed (the
  // restored one on top, ours under it), so the match is per line.
  assert.match(git(cwd, ["stash", "list", "--format=%gs"]), /^git-rebase-visual restored [0-9a-f]{7}$/m);
  assert.match(git(cwd, ["stash", "list", "--format=%s"]), /^On master: user theirs$/m);
});

test("a translated drop message does not defeat the rollback", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const theirs = pushUserStash(cwd, "theirs");
  const { sha } = await stashSnapshot(cwd);
  const before = stashShaSet(cwd);

  // Drop the user's entry with plain Git, as above, but hand the verifier the
  // text a *localized* Git prints. The regex cannot read it, so the only thing
  // that can identify the wrongly dropped entry is the before/after sha sets.
  // A run on a machine with another `LANG` produces exactly this shape, and the
  // previous implementation answered "our entry was removed" and left the user's
  // entry deleted — the rollback collapsed into silence.
  git(cwd, ["stash", "drop", "stash@{1}"]);
  const translated = "Stash verworfen stash@{1} (f824287a475987ca88aa85210f81c5fd81cbac8b)";

  const restored = await undoWrongDrop(cwd, sha, "stash@{1}", translated, before);
  assert.equal(restored.ok, false, "an unparsed message never means a clean removal");
  assert.equal(restored.refused, true);
  const after = stashShaSet(cwd);
  assert.ok(after.includes(theirs), "the sha-set comparison alone found and restored the right entry");
  assert.deepEqual(after, before, "nothing was lost");
});

test("an unreadable drop result is a refusal, not a claimed removal", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);

  // Our entry is still listed and the message cannot be parsed: the drop did not
  // do what it was asked. The only honest answer is "cannot confirm", never
  // `ok: true` — that would record a removal that did not happen.
  const result = await undoWrongDrop(cwd, sha, "stash@{0}", "not a drop message");
  assert.equal(result.ok, false);
  assert.equal(result.gone, false, "our entry is still listed");
  assert.equal(result.refused, true);
  assert.match(result.message, /无法确认删除了哪一条/);
  assert.deepEqual(stashShaSet(cwd), [sha], "nothing was dropped or stored by the verifier");
});

test("a sha already listed twice is a duplicate misdrop from git stash store", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);

  // Our entry is on top, where `git stash store` of *that* commit is a no-op
  // (Git sees `refs/stash` already points at it). The state that produces a
  // duplicate is ours sitting lower down: a later push moves it, and a store of
  // its sha then adds a second reflog entry naming the same commit.
  pushUserStash(cwd, "later");
  const listed = () =>
    git(cwd, ["stash", "list", "--format=%H"]).split("\n").map((line) => line.trim()).filter(Boolean);
  assert.equal(listed().indexOf(sha), 1, "our entry has been pushed to slot 1");
  const stored = await runGit(["stash", "store", "-m", "user copy", sha], { cwd });
  assert.equal(stored.code, 0, stored.stderr);
  assert.equal(listed().filter((entry) => entry === sha).length, 2, "the sha really appears twice");

  // Removal is slot-addressed, so one of the two slots is the user's copy. The
  // slot count is what distinguishes "ours" from "a single entry that still
  // exists", and the only safe answer for a duplicate is to refuse.
  const result = await stashRemoveBySha(cwd, sha);
  assert.equal(result.ok, false);
  assert.equal(result.refused, true, "an ambiguous sha is refused, never guessed");
  assert.match(result.message, /出现了 2 次/, "the message says how many slots name the sha");
  assert.match(result.message, /未删除任何内容/, "and that nothing was removed");
  assert.equal(listed().filter((entry) => entry === sha).length, 2, "neither copy was dropped");
  assert.equal(await stashNameForSha(cwd, sha), undefined, "and no slot is offered as the address of the sha");
});

test("a clean worktree never records an existing entry as the one the plugin created", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const theirs = pushUserStash(cwd, "theirs");

  // The worktree is clean after the user's own stash, so `git stash push` has
  // nothing to save. A localized Git prints that notice in another language, the
  // English regex misses, and the old code then read `stash@{0}` — the *user's*
  // entry — and recorded it as the plugin's own. The recovery path would later
  // delete it once their content satisfied `complete`.
  //
  // The decision is now made from the sha sets, so no locale is needed to test
  // it: a push that created nothing leaves the set unchanged, and `createdStash`
  // sees zero new shas.
  const before = stashShaSet(cwd);
  assert.deepEqual(before, [theirs]);
  const sha = await stashPush(cwd);
  assert.equal(sha, undefined, "no entry was created, so none is claimed");
  assert.deepEqual(stashShaSet(cwd), before, "the user's entry is untouched and unclaimed");

  // The same inputs through the pure decision, with the message Git prints in
  // another language: the answer must not change.
  assert.equal(
    createdStash(before, stashShaSet(cwd), 0, "Es gibt keine lokalen Änderungen zum Speichern"),
    undefined,
    "a translated notice cannot turn an unchanged stack into a claimed entry"
  );
  // And the reverse: a real push with an untranslatable message is still found by
  // identity alone.
  fs.writeFileSync(path.join(cwd, "ours.txt"), "ours\n", "utf8");
  const created = await stashPush(cwd);
  assert.ok(created, "a real push is detected without reading any message");
  assert.notEqual(created, theirs, "and it is our entry, never the user's");
  assert.equal(createdStash([], [created!], 0, "irgendeine Übersetzung"), created);
});

test("a push that raced another one claims no sha at all", async () => {
  // Two new shas appeared, so "the entry this call created" is not determinable.
  // Claiming either one is a guess about which was ours, and a wrong guess feeds
  // the removal path an entry that may belong to the user.
  assert.equal(createdStash([], ["aaaa", "bbbb"], 0, "whatever"), undefined);
  // A failed push created nothing, whatever the stack looks like.
  assert.equal(createdStash([], ["aaaa"], 1, ""), undefined);
  // An unreadable stack on either side is not an empty stack.
  assert.equal(createdStash(undefined, ["aaaa"], 0, ""), undefined);
  assert.equal(createdStash([], undefined, 0, ""), undefined);
});

test("our sha vanishing is not proof that only our sha vanished", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const theirs = pushUserStash(cwd, "theirs");
  const { sha } = await stashSnapshot(cwd);
  const before = stashShaSet(cwd);
  assert.deepEqual(before, [theirs, sha].sort(), "ours on top of the user's entry");

  // A third party drops *our* entry while our own drop takes *theirs*, both
  // inside the same window. `after` is then empty, so "our sha is not listed"
  // is true — and the previous implementation returned `ok: true` on exactly
  // that, leaving the user's entry dropped forever. Both removals are real Git
  // operations here; only the ordering is staged.
  git(cwd, ["stash", "drop", "stash@{0}"]); // ours, by a concurrent hand
  const dropOutput = git(cwd, ["stash", "drop", "stash@{0}"]); // theirs, by ours
  assert.deepEqual(stashShaSet(cwd), [], "both entries really are gone");

  const verdict = dropVerdict(before, [], sha);
  assert.deepEqual(verdict, { kind: "wrong", dropped: theirs }, "identity names the entry that has to go back");

  const restored = await undoWrongDrop(cwd, sha, "stash@{0}", dropOutput, before);
  assert.equal(restored.ok, false, "a double loss is never reported as a clean removal");
  assert.equal(restored.refused, true);
  assert.match(restored.message, /已用 git stash store 原样恢复/);
  assert.deepEqual(stashShaSet(cwd), [theirs], "the user's entry is back in the list");
});

test("a drop that cannot be cross-checked says so instead of claiming a clean removal", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);
  const dropOutput = git(cwd, ["stash", "drop", "stash@{0}"]);

  // No witness: the pre-drop listing was never read. Our sha is demonstrably
  // gone, so `ok/gone` is the only supportable answer — but the message must
  // admit that a second loss could not have been seen.
  const result = await undoWrongDrop(cwd, sha, "stash@{0}", dropOutput);
  assert.equal(result.ok, true);
  assert.equal(result.gone, true);
  assert.match(result.message, /删除前的列表未能读取/, "the caveat is stated, not implied");
  assert.match(result.message, /无法交叉核对/, "and names what was not checked");
});

test("a drop verdict is decided by identity for every shape the list can take", () => {
  const ours = "a".repeat(40);
  const theirs = "b".repeat(40);
  const third = "c".repeat(40);
  // Only ours vanished: correct.
  assert.deepEqual(dropVerdict([theirs, ours], [theirs], ours), { kind: "ours-only" });
  // Ours vanished and theirs vanished with it: the double-loss counterexample.
  assert.deepEqual(dropVerdict([theirs, ours], [], ours), { kind: "wrong", dropped: theirs });
  // The ordinary wrong drop: ours is still there, theirs went.
  assert.deepEqual(dropVerdict([theirs, ours], [ours], ours), { kind: "wrong", dropped: theirs });
  // Two foreign entries gone: the victim cannot be named, so nothing is restored.
  assert.deepEqual(dropVerdict([third, theirs, ours], [ours], ours), {
    kind: "ambiguous",
    foreign: [third, theirs],
  });
  // Ours still listed and nothing else gone: the drop did nothing.
  assert.deepEqual(dropVerdict([theirs, ours], [theirs, ours], ours), { kind: "ours-still-listed" });
  // An unreadable post-drop listing is never "gone".
  assert.deepEqual(dropVerdict([ours], undefined, ours), { kind: "unreadable" });
  // No witness but our sha gone: `ok/gone`, flagged as uncrosschecked by the caller.
  assert.deepEqual(dropVerdict(undefined, [], ours), { kind: "no-witness", oursListed: false });
  assert.deepEqual(dropVerdict(undefined, [theirs], ours), { kind: "no-witness", oursListed: false });
  assert.deepEqual(dropVerdict(undefined, [theirs, ours], ours), { kind: "no-witness", oursListed: true });
  // An empty stack before and after is not a wrong drop of anything.
  assert.deepEqual(dropVerdict([], [], ours), { kind: "ours-only" });
});

test("an unreadable reflog at the removal pre-check is a refusal, never a reported removal", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);

  // The exact shape B measured: `git stash list` prints nothing and exits 0
  // while `refs/stash` still points at the entry. This function used to open with
  // its own `git stash list` and check only `code !== 0`, so the empty listing
  // fell through to "not listed" and returned `gone: true` — a recorded removal
  // of an entry that was still there. It was live only behind `removeOwnStash`'s
  // `presence.listed !== true` gate; reorder that gate and the extension tells
  // the user it deleted its own entry while the entry is still listed.
  fs.rmSync(path.join(cwd, ".git", "logs", "refs", "stash"));
  assert.equal(git(cwd, ["stash", "list", "--format=%H"]).trim(), "", "Git prints nothing");
  assert.equal(git(cwd, ["rev-parse", "--verify", "--quiet", "refs/stash"]).trim(), sha, "the ref is alive");

  const result = await stashRemoveBySha(cwd, sha);
  assert.equal(result.ok, false, "never reported as a removal");
  assert.equal(result.gone, false, "and never as 'no longer present'");
  assert.equal(result.refused, true, "it is a refusal");
  assert.equal(result.kind, "refused", "with the machine-readable kind the announcer branches on");
  assert.match(result.message, /无法读取 stash 列表/, "and says the list could not be read");
  assert.equal(git(cwd, ["rev-parse", "--verify", "--quiet", "refs/stash"]).trim(), sha, "the entry was not touched");

  // A genuinely empty stack is still `gone`, which is the one case where that
  // answer is true: no reflog, no ref, nothing to remove.
  fs.rmSync(path.join(cwd, ".git", "refs", "stash"));
  const empty = await stashRemoveBySha(cwd, sha);
  assert.equal(empty.gone, true, "an empty stack really has no entry to remove");
  assert.equal(empty.refused, false);
});

test("a removal result carries the shape the announcement needs, not just prose", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const theirs = pushUserStash(cwd, "theirs");
  const { sha } = await stashSnapshot(cwd);
  const before = stashShaSet(cwd);

  // The wrong-drop path: `kind` names the outcome and `victim` names the entry,
  // so no caller has to infer either from the message text.
  git(cwd, ["stash", "drop", "stash@{1}"]);
  const restored = await undoWrongDrop(cwd, sha, "stash@{1}", "Dropped stash@{1} (" + theirs + ")", before);
  assert.equal(restored.kind, "undo-restored");
  assert.equal(restored.victim, theirs, "the victim is a field, not a substring");
  assert.equal(stashShaSet(cwd).includes(theirs), true);

  // A clean removal is `removed`, and a duplicate-sha refusal is `refused`.
  assert.equal((await stashRemoveBySha(cwd, sha)).kind, "removed");
  const again = await stashRemoveBySha(cwd, sha);
  assert.equal(again.kind, "gone", "an entry that is already gone is 'gone', not 'removed'");
});

test("a broken stash reflog is not treated as a deleted stash", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);
  // Git reads stash entries from the reflog. Corrupting it makes `git stash
  // list` print nothing while exiting 0, even though `refs/stash` and the stash
  // commits are perfectly intact -- an empty listing alone is not evidence.
  const reflog = path.join(cwd, git(cwd, ["rev-parse", "--git-path", "logs/refs/stash"]));
  assert.ok(fs.existsSync(reflog), "stash reflog exists");
  fs.writeFileSync(reflog, "garbage line\n", "utf8");
  assert.equal(git(cwd, ["stash", "list"]), "", "the listing really is empty");
  assert.equal(git(cwd, ["rev-parse", "refs/stash"]), sha, "but refs/stash still points at the stash");

  const presence = await stashPresence(cwd, sha);
  assert.equal(presence.listed, undefined, "a failed listing is unknown, not 'gone'");
  assert.equal(presence.complete, false);
  assert.equal(resetDecision(presence).action, "keep", "reset must not clear what it could not check");

  const outcome = await reconcilePendingStash(cwd, sha);
  assert.equal(outcome.kind, "pending", "the record survives an unreadable listing");
  assert.match(outcome.kind === "pending" ? outcome.reason : "", /无法读取 stash 列表/);
  assert.equal(git(cwd, ["rev-parse", "refs/stash"]), sha, "nothing was dropped");
});

test("a corrupt reflog reads as unreadable, never as an empty stack, in both modules", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const theirs = pushUserStash(cwd, "theirs");

  // `git stash list` exits 0 with no output while `refs/stash` still points at a
  // real stash commit: deleting the reflog file reproduces it exactly. Both
  // readers used to disagree here — `worktree` called it empty, `pendingRecovery`
  // called it unreadable — and only the caller's ordering kept the empty answer
  // from being acted on.
  const reflog = path.join(cwd, ".git", "logs", "refs", "stash");
  assert.equal(fs.existsSync(reflog), true, "the reflog exists before the corruption");
  fs.rmSync(reflog);
  assert.equal(git(cwd, ["stash", "list", "--format=%H"]).trim(), "", "Git prints nothing");
  assert.equal(git(cwd, ["rev-parse", "--verify", "--quiet", "refs/stash"]).trim(), theirs, "but the ref survives");

  const read = await readStashList(cwd);
  assert.equal(read.state, "unreadable", "the shared predicate calls it unreadable");
  assert.match(read.state === "unreadable" ? read.reason : "", /refs\/stash/, "and says why");
  assert.equal(await stashShas(cwd), undefined, "pendingRecovery does not call it empty");
  assert.equal(await stashShasForComparison(cwd), undefined, "and neither does worktree's comparison");

  // A genuinely empty stack is still `empty`: the ref does not resolve either.
  fs.writeFileSync(reflog, "", "utf8");
  fs.rmSync(path.join(cwd, ".git", "refs", "stash"));
  const empty = await readStashList(cwd);
  assert.equal(empty.state, "empty", "no ref and no listing really is empty");
  assert.deepEqual(await stashShas(cwd), [], "reported as an empty list, not as unreadable");
  assert.deepEqual(await stashShasForComparison(cwd), [], "the comparison can see an empty stack");
});

test("an unreadable stash list is never reported as a missing stash by the restore paths", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);

  // Corrupt the reflog the same way as the shared-predicate test. Every restore
  // path resolves the sha through the list, and "could not look" must not become
  // "it is gone": that report is what tells the user their only copy vanished.
  fs.rmSync(path.join(cwd, ".git", "logs", "refs", "stash"));
  assert.equal(git(cwd, ["stash", "list", "--format=%H"]).trim(), "", "Git prints nothing");
  assert.equal(git(cwd, ["rev-parse", "--verify", "--quiet", "refs/stash"]).trim(), sha, "the entry is really there");

  for (const restore of [stashRestoreForAmend, stashRestoreWorktreeAfterAmend, stashApplyIndexBySha]) {
    const result = await restore(cwd, sha);
    assert.equal(result.ok, false, `${restore.name} does not claim success`);
    assert.equal(result.gone, false, `${restore.name} does not claim the stash disappeared`);
    assert.match(result.message, /无法读取 stash 列表/, `${restore.name} says the list could not be read`);
  }
  // Nothing was written on the way to that answer.
  assert.equal(git(cwd, ["rev-parse", "--verify", "--quiet", "refs/stash"]).trim(), sha, "the entry was not touched");
});

test("every command the banner offers actually runs against a real repository", async () => {
  const cwd = createRepo();
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);
  const name = await stashNameForSha(cwd, sha);
  removeRepo(cwd);
  assert.ok(name, "a healthy reflog resolves the slot");

  // A previous version printed `git stash apply --index stash:<sha7>` whenever
  // the slot could not be resolved. Git has no such ref, so the banner offered a
  // command that always failed -- in exactly the corrupted-reflog case the
  // feature exists for. Execute what is printed instead of asserting strings.
  const commands = recoveryCommands(name, sha).map((step) => step.command.replace(name, "${target}"));
  assert.equal(commands.length, 3, "a resolved slot also offers the explicit drop");
  for (const command of commands) {
    await runOneCommandPerRepo(command);
  }
});

test("an unresolvable slot falls back to commands that Git can still run", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);

  // No name: the case a corrupted stash reflog produces.
  const steps = recoveryCommands(undefined, sha);
  assert.deepEqual(steps.map((step) => step.command), [
    `git stash apply --index ${sha}`,
    `git stash apply ${sha}`,
  ]);
  assert.equal(
    steps.some((step) => step.command.startsWith("git stash drop")),
    false,
    "Git has no sha-addressed stash drop, so one is not offered"
  );
  // The apply commands must genuinely work, or the banner is still a dead end.
  // Each is executed on its own repository: they are alternatives, not a queue.
  // The recorded sha is from this repo; the helper builds an equivalent stash of
  // its own, so the template re-resolves the target to that repository's sha.
  for (const step of steps) {
    await runOneCommandPerRepo(step.command.replace(sha, "${target}"));
  }
  assert.equal(git(cwd, ["stash", "list"]).includes("stash@{0}"), true, "nothing executed here removed the entry");
});
