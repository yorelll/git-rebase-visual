import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as path from "path";
import { continueRebase, resolveBase, executeRebase } from "../src/git/rebaseEngine";
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
import { GitInvocationLog, runGit, setGitInvocationObserver } from "../src/git/gitRunner";
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
import { cleanupRepo, commitFile, createRepo, git, removeRepo } from "./helpers/gitTestRepo";

/** Aborts any paused rebase so the temp directory can be removed. */
function cleanup(t: { after: (fn: () => void) => void }, cwd: string): void {
  t.after(() => {
    const rebaseState = git(cwd, ["rev-parse", "--git-path", "rebase-merge"]);
    if (fs.existsSync(path.join(cwd, rebaseState))) {
      git(cwd, ["rebase", "--abort"]);
    }
    removeRepo(cwd);
  });
}

/** Creates a repo with a staged file plus an untracked file, then stashes both. */
async function stashSnapshot(cwd: string): Promise<{ sha: string }> {
  fs.writeFileSync(path.join(cwd, "staged.txt"), "staged content\n", "utf8");
  git(cwd, ["add", "staged.txt"]);
  fs.writeFileSync(path.join(cwd, "untracked.txt"), "untracked content\n", "utf8");
  const sha = await stashPush(cwd);
  assert.ok(sha, "stash was created");
  return { sha };
}

test("an already-applied snapshot resolves and removes the extension's own entry", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);

  // `stash apply` does not drop the stash, so "still listed" must not be read as
  // "not restored". Applying manually first proves content is the authority.
  const applied = await stashApplyIndexBySha(cwd, sha);
  assert.equal(applied.ok, true);
  assert.ok((await stashPresence(cwd, sha)).listed, "apply keeps the stash listed");

  const outcome = await reconcilePendingStash(cwd, sha);
  assert.equal(outcome.kind, "resolved");
  assert.match(outcome.kind === "resolved" ? outcome.detail : "", /内容已在工作区/);
  // The content is verifiably back, so the extension's own entry is a duplicate.
  assert.deepEqual(
    outcome.kind === "resolved" ? outcome.stashRemoved : undefined,
    [{ status: "removed", kind: "removed", sha, name: "stash@{0}" }],
    "the extension's own entry is reported as removed"
  );
  assert.equal(git(cwd, ["stash", "list"]), "", "and it is really gone from the list");
});

test("manual git stash apply --index followed by reconciliation clears silently and removes our entry", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);

  // Exactly the manual recovery the old warning told the user to perform.
  git(cwd, ["stash", "apply", "--index", await stashNameForSha(cwd, sha) as string]);
  const outcome = await reconcilePendingStash(cwd, sha);
  assert.equal(outcome.kind, "resolved", "a manual restore is detected and not repeated");
  assert.equal(fs.readFileSync(path.join(cwd, "staged.txt"), "utf8").replace(/\r\n/g, "\n"), "staged content\n");
  assert.equal(fs.readFileSync(path.join(cwd, "untracked.txt"), "utf8").replace(/\r\n/g, "\n"), "untracked content\n");
  assert.equal(git(cwd, ["stash", "list"]), "", "the extension's own entry does not linger");
});

test("a moot record whose stash is gone clears silently with nothing to restore", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);
  git(cwd, ["stash", "drop", "stash@{0}"]);

  const outcome = await reconcilePendingStash(cwd, sha);
  assert.equal(outcome.kind, "resolved");
  assert.match(outcome.kind === "resolved" ? outcome.detail : "", /无可恢复内容/);
  assert.equal(git(cwd, ["stash", "list"]), "");
});

test("a fresh snapshot is restored once and its entry is then removed", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);
  assert.ok((await stashPresence(cwd, sha)).listed);

  const outcome = await reconcilePendingStash(cwd, sha);
  assert.equal(outcome.kind, "restored");
  assert.deepEqual(
    outcome.kind === "restored" ? outcome.stashRemoved : undefined,
    [{ status: "removed", kind: "removed", sha, name: "stash@{0}" }],
    "the restored entry is removed, not left behind"
  );
  assert.equal(git(cwd, ["stash", "list"]), "", "git stash list is empty again");
  assert.equal(git(cwd, ["diff", "--cached", "--name-only"]), "staged.txt");
  assert.equal(fs.existsSync(path.join(cwd, "untracked.txt")), true);
});

test("repeated reconciliation of the same applied snapshot never re-applies it", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);

  const first = await reconcilePendingStash(cwd, sha);
  assert.equal(first.kind, "restored");
  // A second pass (as the 1.5 s poll would run) is already resolved: content is
  // present, so applying again would duplicate changes or conflict.
  for (let poll = 0; poll < 3; poll++) {
    const repeat = await reconcilePendingStash(cwd, sha);
    assert.equal(repeat.kind, "resolved");
  }
});

test("a conflicting apply keeps the snapshot instead of losing it", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  fs.writeFileSync(path.join(cwd, "shared.txt"), "stashed\n", "utf8");
  git(cwd, ["add", "shared.txt"]);
  const sha = await stashPush(cwd);
  assert.ok(sha);
  // A conflicting edit in the worktree makes `apply --index` refuse.
  fs.writeFileSync(path.join(cwd, "shared.txt"), "conflicting\n", "utf8");

  const outcome = await reconcilePendingStash(cwd, sha);
  assert.equal(outcome.kind, "pending", "a conflict must stay pending");
  assert.equal(outcome.kind === "pending" ? outcome.stashSha : undefined, sha);
  assert.equal((await stashPresence(cwd, sha)).listed, true, "the recovery copy is never dropped unverified");
});

test("an append snapshot already in the index resolves without re-applying", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  const first = commitFile(cwd, "first.txt", "first\n", "first");
  commitFile(cwd, "later.txt", "later\n", "later");
  const { sha } = await stashSnapshot(cwd);

  // Simulate the aborted append: the snapshot is back in the index but the
  // persisted record survived, and the target is still an ancestor of HEAD.
  await stashApplyIndexBySha(cwd, sha);
  const outcome = await reconcilePendingAppend(cwd, { changeStash: sha, targetHash: first, amended: false });
  assert.notEqual(outcome.kind, "pending");
  assert.equal(git(cwd, ["diff", "--cached", "--name-only"]).split("\n").sort().join(","), "staged.txt");
});

test("an index-only match never resolves the record while untracked content is still only in the stash", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  const first = commitFile(cwd, "first.txt", "first\n", "first");
  const target = commitFile(cwd, "target.txt", "target\n", "target");
  const { sha } = await stashSnapshot(cwd);

  // Real append: stop at the target, restore the snapshot, amend, continue.
  const stopped = await executeRebase(cwd, {
    onto: await resolveBase(cwd, first),
    items: [
      { hash: first, action: "pick", subject: "first" },
      { hash: target, action: "edit", subject: "target" },
    ],
  });
  assert.equal(stopped.stopped, true);
  const applied = await stashApplyIndexBySha(cwd, sha);
  assert.equal(applied.ok, true);
  git(cwd, ["commit", "--amend", "--no-edit"]);

  // Drop the untracked file the amend left on disk, so it survives only in
  // `stash^3`. This is B's `index: present, worktree: present, untracked:
  // missing, complete: false` state: `contentPresent` is false, but an index
  // match used to be enough to clear the record and drop the only copy.
  fs.rmSync(path.join(cwd, "untracked.txt"));
  const presence = await stashPresence(cwd, sha);
  assert.equal(presence.index, "present");
  assert.equal(presence.untracked, "missing");
  assert.equal(presence.complete, false);

  const outcome = await reconcilePendingAppend(cwd, { changeStash: sha, targetHash: target, amended: true });
  assert.equal(outcome.kind, "restored", "the residual content is reconciled, not stuck");
  assert.equal(
    fs.readFileSync(path.join(cwd, "untracked.txt"), "utf8").replace(/\r\n/g, "\n"),
    "untracked content\n",
    "the untracked file is put back instead of losing the record"
  );
  // The residual restore put the untracked file back, so every part is now
  // verified and the entry is a duplicate of content that exists on disk.
  assert.equal(git(cwd, ["stash", "list"]), "", "the entry is removed once its content is back");
});

test("an append whose amend landed resolves on a confirmed tree match and removes its entry", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  const first = commitFile(cwd, "first.txt", "first\n", "first");
  const target = commitFile(cwd, "target.txt", "target\n", "target");
  const { sha } = await stashSnapshot(cwd);

  // Real edit-stop rebase, amend, then complete: the staged snapshot becomes
  // part of the rewritten target commit.
  const stopped = await executeRebase(cwd, {
    onto: await resolveBase(cwd, first),
    items: [
      { hash: first, action: "pick", subject: "first" },
      { hash: target, action: "edit", subject: "target" },
    ],
  });
  assert.equal(stopped.stopped, true);
  const applied = await stashApplyIndexBySha(cwd, sha);
  assert.equal(applied.ok, true);
  git(cwd, ["commit", "--amend", "--no-edit"]);
  git(cwd, ["rebase", "--continue"]);
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), git(cwd, ["rev-parse", "HEAD"]));
  assert.notEqual(git(cwd, ["rev-parse", "HEAD"]), target, "the target commit was rewritten");

  const outcome = await reconcilePendingAppend(cwd, { changeStash: sha, targetHash: target, amended: true });
  assert.equal(outcome.kind, "resolved");
  assert.deepEqual(
    outcome.kind === "resolved" ? outcome.stashRemoved : undefined,
    [{ status: "removed", kind: "removed", sha, name: "stash@{0}" }],
    "the transaction's own entry is removed"
  );
  assert.equal(git(cwd, ["stash", "list"]), "", "and git stash list is empty again");
  assert.equal(fs.existsSync(path.join(cwd, "untracked.txt")), true, "the untracked content is restored");
});

test("a landed append whose file was edited again later stays pending rather than guessing", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  // A realistically long file: the append touches one line, a later commit
  // touches a different line, so the file's final blob is not the appended blob.
  const original = Array.from({ length: 20 }, (_, i) => `LINE${i + 1}`);
  const write = (line2: string, line18: string) => {
    const copy = [...original];
    copy[1] = line2;
    copy[17] = line18;
    fs.writeFileSync(path.join(cwd, "shared.txt"), copy.join("\n") + "\n", "utf8");
  };
  write("LINE2", "LINE18");
  git(cwd, ["add", "shared.txt"]);
  git(cwd, ["commit", "-qm", "shared file"]);
  const target = git(cwd, ["rev-parse", "HEAD"]);

  // Stage the append (line 2) and snapshot it exactly like the extension does.
  write("LINE2-APPEND", "LINE18");
  git(cwd, ["add", "shared.txt"]);
  const sha = await stashPush(cwd);
  assert.ok(sha, "the snapshot was created");

  // Apply at the edit stop, amend the target, then let a later commit rewrite
  // another line of the same file.
  const applied = await stashApplyIndexBySha(cwd, sha);
  assert.equal(applied.ok, true);
  git(cwd, ["commit", "--amend", "--no-edit"]);
  write("LINE2-APPEND", "LINE18-LATER");
  git(cwd, ["add", "shared.txt"]);
  git(cwd, ["commit", "-qm", "later same-file edit"]);
  assert.equal(git(cwd, ["status", "--porcelain"]), "", "the append did land");
  assert.notEqual(
    git(cwd, ["rev-parse", `${sha}^2:shared.txt`]),
    git(cwd, ["rev-parse", "HEAD:shared.txt"]),
    "the final file content differs from the appended snapshot"
  );

  // The tree no longer matches the snapshot (a later commit rewrote the file).
  // Under the strict tree comparison this is unconfirmed, and that is fine:
  // the record stays, the banner offers the manual commands, and the stash is
  // still there. Nothing is lost by asking.
  const committed = await stagedSnapshotInHead(cwd, sha);
  assert.equal(committed.committed, false, committed.detail);
  assert.match(committed.detail, /shared\.txt/);

  const outcome = await reconcilePendingAppend(cwd, { changeStash: sha, targetHash: target, amended: true });
  assert.equal(outcome.kind, "pending", "a later edit leaves the record pending instead of guessing");
  assert.equal(git(cwd, ["stash", "list"]).includes("stash@{0}"), true, "the stash is untouched");
});

test("a later rewrite that discards the appended blob keeps the record", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  const base = commitFile(cwd, "shared.txt", "original\n", "base");
  const target = commitFile(cwd, "shared.txt", "target version\n", "target");

  // Snapshot a staged change on the target, then throw the history away (the
  // `reset --hard` shape B reported): the snapshot's content is in no commit
  // reachable from HEAD, so the tree comparison must fail even though the path
  // itself still exists in HEAD.
  fs.writeFileSync(path.join(cwd, "shared.txt"), "appended\n", "utf8");
  git(cwd, ["add", "shared.txt"]);
  const sha = await stashPush(cwd);
  assert.ok(sha);
  git(cwd, ["reset", "-q", "--hard", base]);

  assert.equal(fs.existsSync(path.join(cwd, "shared.txt")), true, "the path still exists");
  const committed = await stagedSnapshotInHead(cwd, sha);
  assert.equal(committed.committed, false, "an existing file is not proof the appended content landed");
  assert.match(committed.detail, /shared\.txt/);

  const outcome = await reconcilePendingAppend(cwd, { changeStash: sha, targetHash: target, amended: true });
  assert.equal(outcome.kind, "pending");
  assert.equal(git(cwd, ["stash", "list"]).includes("stash@{0}"), true, "nothing was dropped");
});

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

test("an unfinished append keeps the record while the target is still an ancestor", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  const first = commitFile(cwd, "first.txt", "first\n", "first");
  commitFile(cwd, "target.txt", "target\n", "target");
  const { sha } = await stashSnapshot(cwd);

  // Contradictory worktree content forces the restore of the original index to
  // fail, which must keep the transaction instead of silently discarding it.
  fs.writeFileSync(path.join(cwd, "staged.txt"), "conflicting\n", "utf8");
  const outcome = await reconcilePendingAppend(cwd, { changeStash: sha, targetHash: first, amended: false });
  assert.equal(outcome.kind, "pending", "an unfinished append keeps the record");
  assert.equal(outcome.kind === "pending" ? outcome.stashSha : undefined, sha);
  assert.equal((await stashPresence(cwd, sha)).listed, true, "the recovery stash survives the failed restore");
});

/**
 * Regression for the silent-abandon sequence.
 *
 * When the restore failed with the fake `modify/delete` conflicts, the toast told
 * the user to resolve and stage the "conflicts". Doing exactly that (`git add`
 * the reported files) makes the index match the snapshot, so `stashPresence`
 * reported `index: present` and the record resolved — while the paused rebase
 * still held the original target and the append had never been amended. The
 * user's staged intent was dropped without a word.
 *
 * The append only counts as done when the amend landed (`stagedSnapshotInHead`
 * confirms the content, or the record is marked `amended`). Restoring the index
 * while the target is still an ancestor means the transaction is live, so the
 * record must survive.
 */
test("a restored index alone never resolves a paused append", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);

  commitFile(cwd, "first.txt", "first\n", "init");
  const target = commitFile(cwd, "target.txt", "target\n", "add target");
  const later = commitFile(cwd, "later.txt", "later\n", "add later");

  // One staged file, plus a worktree-only edit on a later commit's file: the
  // shape that produced the bogus conflicts.
  fs.writeFileSync(path.join(cwd, "target.txt"), "target\nSTAGED-APPEND\n", "utf8");
  git(cwd, ["add", "target.txt"]);
  fs.writeFileSync(path.join(cwd, "later.txt"), "later\nWORKTREE-ONLY\n", "utf8");

  const sha = await stashPush(cwd);
  assert.ok(sha, "stash was created");

  // Stop at the target commit, exactly where the append pauses.
  const outcome = await executeRebase(cwd, {
    onto: await resolveBase(cwd, target),
    items: [
      { hash: target, action: "edit", subject: "add target" },
      { hash: later, action: "pick", subject: "add later" },
    ],
  });
  assert.equal(outcome.stopped, true);
  assert.equal(await isRebaseInProgress(cwd), true);

  // The user obeys the old toast: keep the content and stage the "conflicts".
  // The index now matches the snapshot even though nothing was amended.
  await stashApplyIndexBySha(cwd, sha);
  git(cwd, ["add", "later.txt"]);

  const reconciled = await reconcilePendingAppend(cwd, {
    changeStash: sha,
    targetHash: target,
    amended: false,
  });
  assert.equal(
    reconciled.kind,
    "pending",
    `a paused append must not resolve merely because the index matches (${JSON.stringify(reconciled)})`
  );
  // `pending` is decided before any removal, so the entry is still listed at the
  // moment the record is kept. The extension only removes entries on a settled
  // outcome whose content it verified.
  assert.equal((await stashPresence(cwd, sha)).listed, true, "a pending record never removes its entry");

  // The append really did not happen: the target commit still holds its own file.
  assert.equal(git(cwd, ["show", "HEAD:target.txt"]).replace(/\r\n/g, "\n"), "target", "nothing was appended");

  // After an explicit Abort the same state is a genuine success, not a warning.
  git(cwd, ["rebase", "--abort"]);
  git(cwd, ["clean", "-fdq"]);
  const afterAbort = await reconcilePendingAppend(cwd, {
    changeStash: sha,
    targetHash: target,
    amended: false,
  });
  assert.notEqual(afterAbort.kind, "pending", "an aborted append settles instead of warning forever");
});

test("reset clears orphaned bookkeeping but keeps a stash that still holds content", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);

  // A conflicting worktree edit keeps the content out of the workspace, so the
  // stash is still the only copy and reset must not touch it.
  fs.writeFileSync(path.join(cwd, "staged.txt"), "conflicting\n", "utf8");
  const pending = await stashPresence(cwd, sha);
  const keep = resetDecision(pending);
  assert.equal(keep.action, "keep");
  assert.match(keep.reason, /仍保存未恢复的改动/);

  // The orphan case: the stash is gone, so only the bookkeeping remains.
  git(cwd, ["stash", "drop", "stash@{0}"]);
  const orphan = resetDecision(await stashPresence(cwd, sha));
  assert.equal(orphan.action, "clear");
  assert.match(orphan.reason, /不在列表中/);

  // The resolved case: content already present is also safe to clear.
  fs.rmSync(path.join(cwd, "staged.txt"), { force: true });
  const second = await stashSnapshot(cwd);
  await stashApplyIndexBySha(cwd, second.sha);
  const resolved = resetDecision(await stashPresence(cwd, second.sha));
  assert.equal(resolved.action, "clear");
  assert.match(resolved.reason, /内容已在工作区/);
});

test("a settled recovery reports the entry it removed, and leaves an unverified one alone", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);

  const outcome = await reconcilePendingStash(cwd, sha);
  assert.equal(outcome.kind, "restored");
  if (outcome.kind === "restored") {
    assert.deepEqual(
      outcome.stashRemoved,
      [{ status: "removed", kind: "removed", sha, name: "stash@{0}" }],
      "only content this extension verified is removed, and it is reported"
    );
  }
  assert.equal(git(cwd, ["stash", "list"]), "", "nothing of ours is left in the list");

  // A stash the extension never created is not in any record, so no path can
  // reach the removal helper with its sha. Push one and re-run the same pass.
  fs.writeFileSync(path.join(cwd, "theirs.txt"), "theirs\n", "utf8");
  git(cwd, ["stash", "push", "-u", "-q"]);
  const theirs = git(cwd, ["rev-parse", "stash@{0}"]);
  const again = await reconcilePendingStash(cwd, sha);
  assert.equal(again.kind, "resolved", "the record is moot: its sha is no longer listed");
  assert.equal(
    (again.kind === "resolved" ? again.stashRemoved : undefined),
    undefined,
    "a moot record reports no removal"
  );
  assert.deepEqual(
    git(cwd, ["stash", "list", "--format=%H"]).split("\n").map((line) => line.trim()).filter(Boolean),
    [theirs],
    "the user's own stash is untouched"
  );
});

/** Deletes a loose object so the corresponding Git read fails hard. */
function deleteLooseObject(cwd: string, objectId: string): void {
  const file = path.join(cwd, git(cwd, ["rev-parse", "--git-path", "objects"]), objectId.slice(0, 2), objectId.slice(2));
  assert.ok(fs.existsSync(file), `object ${objectId.slice(0, 7)} exists before deletion`);
  fs.rmSync(file);
}

test("a failing untracked-snapshot probe never drops the stash", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);
  // Deleting the ^3 tree used to make `changedPaths`/`treeBlobs` report nothing
  // to verify, which set `complete` and authorised dropping the only copy.
  const third = git(cwd, ["rev-parse", `${sha}^3`]);
  deleteLooseObject(cwd, git(cwd, ["rev-parse", `${third}^{tree}`]));

  const presence = await stashPresence(cwd, sha);
  assert.notEqual(presence.probeError, undefined, "the broken probe is reported");
  assert.equal(presence.complete, false, "an unreadable probe can never be complete");

  const outcome = await reconcilePendingStash(cwd, sha);
  assert.equal(outcome.kind, "pending");
  assert.equal(git(cwd, ["stash", "list"]).includes("stash@{0}"), true, "the stash is still there");
  assert.equal(fs.existsSync(path.join(cwd, "untracked.txt")), false, "content was not invented");
});

test("a stash whose base commit cannot be read keeps the record and warns", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);
  deleteLooseObject(cwd, git(cwd, ["rev-parse", `${sha}^1`]));

  const presence = await stashPresence(cwd, sha);
  assert.notEqual(presence.probeError, undefined);
  assert.equal(presence.complete, false);
  const outcome = await reconcilePendingStash(cwd, sha);
  assert.equal(outcome.kind, "pending");
  assert.match(outcome.kind === "pending" ? outcome.reason : "", /无法确认|无法读取/);
  assert.equal(git(cwd, ["stash", "list"]).includes("stash@{0}"), true);
});

test("a non-zero git diff while probing keeps the stash", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);
  // A broken index makes `git diff --cached` exit non-zero; that must be read as
  // "unknown", not as "content is present".
  const indexPath = path.join(cwd, git(cwd, ["rev-parse", "--git-path", "index"]));
  fs.writeFileSync(indexPath, "not an index\n", "utf8");
  const presence = await stashPresence(cwd, sha);
  assert.equal(presence.complete, false, "a failed diff is never evidence of presence");
  const outcome = await reconcilePendingStash(cwd, sha);
  assert.equal(outcome.kind, "pending");
  assert.notEqual(presence.probeError, undefined);
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

test("an unreadable index snapshot keeps the record instead of claiming presence", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);
  // `stash^2` is the index snapshot. Without it the staged half cannot be
  // compared, and "nothing to compare" must never become "content is present".
  deleteLooseObject(cwd, git(cwd, ["rev-parse", `${sha}^2`]));

  const presence = await stashPresence(cwd, sha);
  assert.notEqual(presence.probeError, undefined, "the failed index probe is reported");
  assert.equal(presence.complete, false);
  assert.equal(resetDecision(presence).action, "keep", "reset keeps what it cannot verify");

  const outcome = await reconcilePendingStash(cwd, sha);
  assert.equal(outcome.kind, "pending");
  assert.equal(git(cwd, ["stash", "list"]).includes("stash@{0}"), true, "nothing was dropped");
});

test("an unreadable untracked commit object keeps the record", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);
  // The parent list lives in the stash commit itself, so deleting the `^3`
  // *commit* (not its tree) leaves a commit that still names three parents —
  // but an untracked snapshot that cannot be read. That is a probe error, never
  // "absent". `rev-list` cannot walk a missing parent, so read the object.
  deleteLooseObject(cwd, git(cwd, ["rev-parse", `${sha}^3`]));
  const parentLines = git(cwd, ["cat-file", "-p", sha]).split("\n").filter((line) => line.startsWith("parent "));
  assert.equal(parentLines.length, 3, "the stash commit still names its untracked parent");

  const presence = await stashPresence(cwd, sha);
  assert.notEqual(presence.probeError, undefined);
  assert.equal(presence.complete, false);

  const outcome = await reconcilePendingStash(cwd, sha);
  assert.equal(outcome.kind, "pending");
  assert.equal(git(cwd, ["stash", "list"]).includes("stash@{0}"), true, "nothing was dropped");
});

/** Exact sha set of `git stash list`, oldest last, for order-insensitive equality. */
function stashShaSet(cwd: string): string[] {
  return git(cwd, ["stash", "list", "--format=%H"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

/** A stash the extension did not create, on its own file. */
function pushUserStash(cwd: string, name: string): string {
  fs.writeFileSync(path.join(cwd, `${name}.txt`), `${name}\n`, "utf8");
  git(cwd, ["stash", "push", "-u", "-q", "-m", `user ${name}`]);
  return git(cwd, ["rev-parse", "stash@{0}"]);
}

test("a staged rename restored only at its destination keeps the entry", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "a.txt", "original\n", "base");
  const base = git(cwd, ["rev-parse", "HEAD"]);

  // A staged rename is one change with two halves: the addition of `b.txt` and
  // the deletion of `a.txt`. Without `--no-renames`, `git diff --name-only`
  // reports it as `b.txt` alone, so every probe built on that list asks only
  // about the destination.
  git(cwd, ["mv", "a.txt", "b.txt"]);
  const sha = await stashPush(cwd);
  assert.ok(sha, "the rename snapshot exists");
  assert.equal(
    git(cwd, ["diff", "--name-only", `${sha}^1`, `${sha}^2`]),
    "b.txt",
    "Git collapses the rename to its destination unless --no-renames is passed"
  );
  assert.equal(
    git(cwd, ["diff", "--name-only", "--no-renames", `${sha}^1`, `${sha}^2`]).split("\n").sort().join(","),
    "a.txt,b.txt",
    "with --no-renames both halves are visible"
  );

  // The user restores the destination only: `b.txt` is staged with the right
  // content, while the staged deletion of `a.txt` never returned to the index.
  // The destination-only view calls that "index: present" and `complete: true`,
  // and the entry used to be deleted with half the staged change still missing.
  fs.writeFileSync(path.join(cwd, "b.txt"), "original\n", "utf8");
  git(cwd, ["add", "b.txt"]);
  fs.rmSync(path.join(cwd, "a.txt"));

  const presence = await stashPresence(cwd, sha);
  assert.equal(presence.index, "missing", "the staged deletion of a.txt has not returned");
  assert.equal(presence.complete, false, "half the staged change is missing, so the entry is not removable");

  const outcome = await reconcilePendingAppend(cwd, {
    changeStash: sha,
    targetHash: base,
    amended: false,
  });
  assert.notEqual(outcome.kind, "resolved", "a half-restored rename is never reported as resolved");
  assert.deepEqual(stashShaSet(cwd), [sha], "and the entry is kept, because it is still the only copy");
});


test("a successful autostash recovery leaves exactly the user's pre-existing entries, by sha", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const theirs = pushUserStash(cwd, "theirs");
  const before = stashShaSet(cwd);
  assert.deepEqual(before, [theirs].sort(), "the user's entry set before the plugin acts");

  const { sha } = await stashSnapshot(cwd);
  assert.notEqual(sha, theirs);
  assert.deepEqual(stashShaSet(cwd), [theirs, sha].sort(), "the plugin's entry is on top");

  const outcome = await reconcilePendingStash(cwd, sha);
  assert.equal(outcome.kind, "restored");
  assert.deepEqual(stashShaSet(cwd), before, "the sha set equals the user's pre-existing set, not merely the same count");
  // The content really is back, so the removal lost nothing.
  assert.equal(git(cwd, ["diff", "--cached", "--name-only"]), "staged.txt");
  assert.equal(fs.readFileSync(path.join(cwd, "untracked.txt"), "utf8").replace(/\r\n/g, "\n"), "untracked content\n");
});

test("a successful append recovery leaves exactly the user's pre-existing entries, by sha", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const theirs = pushUserStash(cwd, "theirs");
  const before = stashShaSet(cwd);
  assert.deepEqual(before, [theirs].sort(), "the user's entry set before the plugin acts");

  // The append transaction's own change stash, applied by hand so the content is
  // verifiably back and the record resolves.
  fs.writeFileSync(path.join(cwd, "staged.txt"), "staged\n", "utf8");
  git(cwd, ["add", "staged.txt"]);
  const sha = await stashPush(cwd);
  assert.ok(sha);
  git(cwd, ["stash", "apply", "--index", sha]);
  assert.equal((await stashPresence(cwd, sha)).complete, true, "every part was verified");

  const outcome = await reconcilePendingAppend(cwd, { changeStash: sha, targetHash: git(cwd, ["rev-parse", "HEAD"]), amended: false });
  assert.equal(outcome.kind, "resolved");
  assert.deepEqual(stashShaSet(cwd), before, "the sha set equals the user's pre-existing set after the append settles");
});

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

test("a pop-style conflicting restore keeps the extension's entry and reports it", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  fs.writeFileSync(path.join(cwd, "shared.txt"), "stashed\n", "utf8");
  git(cwd, ["add", "shared.txt"]);
  const sha = await stashPush(cwd);
  assert.ok(sha);
  // A conflicting edit makes `apply --index` refuse, so the content is not back
  // and the entry must not be removed.
  fs.writeFileSync(path.join(cwd, "shared.txt"), "conflicting\n", "utf8");

  const outcome = await reconcilePendingStash(cwd, sha);
  assert.equal(outcome.kind, "pending", "a conflict keeps the record");
  assert.match(outcome.kind === "pending" ? outcome.reason : "", /apply --index 未能在工作区复现完整内容/);
  assert.deepEqual(stashShaSet(cwd), [sha], "the entry is kept, not consumed by the failed restore");
});

test("the user's own stashes are never removed in any recovery path", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  // Several user entries, so any off-by-one slot arithmetic shows up as a
  // wrong sha in the set rather than being hidden by a single-entry list.
  const userOne = pushUserStash(cwd, "one");
  const userTwo = pushUserStash(cwd, "two");
  const before = stashShaSet(cwd);
  assert.deepEqual(before, [userOne, userTwo].sort());

  const { sha } = await stashSnapshot(cwd);
  const withOurs = stashShaSet(cwd);
  assert.equal(withOurs.length, 3, "ours plus the user's two");

  // Run every reconciliation path the extension has against the same repo.
  await reconcilePendingStash(cwd, sha);
  await reconcilePendingAppend(cwd, { changeStash: sha, targetHash: git(cwd, ["rev-parse", "HEAD"]), amended: false });
  await reconcilePendingAppend(cwd, { changeStash: sha, targetHash: git(cwd, ["rev-parse", "HEAD"]), amended: true });

  const after = stashShaSet(cwd);
  for (const entry of before) {
    assert.ok(after.includes(entry), `the user's entry ${entry.slice(0, 7)} is still listed`);
  }
  assert.equal(after.length, before.length, "nothing the user created was removed");
});

test("a rewritten target without the snapshot in HEAD keeps the record", async (t) => {

  const cwd = createRepo();
  cleanup(t, cwd);
  const base = commitFile(cwd, "base.txt", "base\n", "base");
  const target = commitFile(cwd, "target.txt", "target\n", "target");
  const { sha } = await stashSnapshot(cwd);
  // Rewrite history so `target` is no longer an ancestor but HEAD does not
  // contain the snapshot either: ancestry alone must not resolve the record.
  git(cwd, ["reset", "-q", "--hard", base]);

  const outcome = await reconcilePendingAppend(cwd, { changeStash: sha, targetHash: target });
  assert.equal(outcome.kind, "pending", "an unverified rewrite keeps the record");
  assert.match(outcome.kind === "pending" ? outcome.reason : "", /无法确认快照已进入 HEAD/);
  assert.equal(git(cwd, ["stash", "list"]).includes("stash@{0}"), true, "nothing was dropped");
});

test("a settled record removes its own slot and leaves the user's stashes untouched", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  // A stash the extension did not create, pushed before it acts: this is the
  // entry that must survive by exact sha, not by count.
  fs.writeFileSync(path.join(cwd, "theirs.txt"), "theirs\n", "utf8");
  git(cwd, ["stash", "push", "-u", "-q"]);
  const theirs = git(cwd, ["rev-parse", "stash@{0}"]);
  const before = git(cwd, ["stash", "list", "--format=%H"]).split("\n").map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(before, [theirs], "the user's pre-existing entry set");

  const { sha } = await stashSnapshot(cwd);
  assert.ok(sha, "our stash exists");
  assert.notEqual(sha, theirs);
  // Our entry sits above the user's, so its slot is @{0} and shifting is real.
  const name = await stashNameForSha(cwd, sha);
  assert.equal(name, "stash@{0}", "the sha resolves to its current slot, not a stale index");

  git(cwd, ["stash", "apply", "--index", name as string]);
  assert.equal((await stashPresence(cwd, sha)).complete, true, "every part was verified");

  const outcome = await reconcilePendingStash(cwd, sha);
  assert.equal(outcome.kind, "resolved");
  assert.deepEqual(
    outcome.kind === "resolved" ? outcome.stashRemoved : undefined,
    [{ status: "removed", kind: "removed", sha, name: "stash@{0}" }],
    "the extension removed its own entry and says so"
  );
  const remaining = git(cwd, ["stash", "list", "--format=%H"]).split("\n").map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(remaining, [theirs], "git stash list holds exactly what the user had before the plugin acted");
});

test("a stash whose slot no longer resolves still settles without claiming a removal", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);
  // Remove the stash behind Git's back so its commits still exist but no name
  // resolves to it. The content is already back in the worktree, so the record
  // settles -- but no removal may be reported, and the unlisted state still
  // counts as unverified.
  const applied = await stashApplyIndexBySha(cwd, sha);
  assert.equal(applied.ok, true);
  git(cwd, ["update-ref", "-d", "refs/stash"]);
  assert.equal(await stashNameForSha(cwd, sha), undefined, "no slot resolves to the sha");

  const presence = await stashPresence(cwd, sha);
  assert.equal(presence.listed, false);
  assert.equal(presence.complete, false, "an unlisted stash is never complete");
  const outcome = await reconcilePendingStash(cwd, sha);
  assert.equal(outcome.kind, "resolved", "the content is verifiably back, so the record settles");
  assert.equal(
    (outcome.kind === "resolved" ? outcome.stashRemoved : undefined),
    undefined,
    "nothing was removed, so nothing may be reported as removed"
  );
});

/**
 * The shapes below are the Round-4 findings, now handled by design rather than
 * by a better containment predicate: the extension never removes an entry whose
 * content it could not confirm, so an ambiguous shape simply keeps its record,
 * its banner and its stash. Each test asserts the *record* outcome and,
 * crucially, that the extension's entry survives whenever it could not verify
 * the content was back.
 */

test("a completed append whose content matches HEAD resolves and removes its own entry", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  const original = Array.from({ length: 20 }, (_, i) => `LINE${i + 1}`);
  const write = (line2: string) => {
    const copy = [...original];
    copy[1] = line2;
    fs.writeFileSync(path.join(cwd, "shared.txt"), copy.join("\n") + "\n", "utf8");
  };
  write("LINE2");
  git(cwd, ["add", "shared.txt"]);
  git(cwd, ["commit", "-qm", "base"]);
  fs.copyFileSync(path.join(cwd, "shared.txt"), path.join(cwd, "template.txt"));
  git(cwd, ["add", "template.txt"]);
  const baseline = git(cwd, ["rev-parse", "HEAD"]);

  write("LINE2-APPEND");
  git(cwd, ["add", "shared.txt"]);
  git(cwd, ["commit", "-qm", "target"]);
  const target = git(cwd, ["rev-parse", "HEAD"]);

  // Revert `shared.txt` to the baseline content and snapshot it: the blob is
  // reused from `template.txt`, never newly created.
  write("LINE2");
  git(cwd, ["add", "shared.txt"]);
  const sha = await stashPush(cwd);
  assert.ok(sha, "the snapshot was created");
  const snapshotBlob = git(cwd, ["rev-parse", `${sha}^2:shared.txt`]);
  assert.equal(
    git(cwd, ["rev-parse", `${sha}^1:template.txt`]),
    snapshotBlob,
    "the snapshot's blob already exists at the baseline (the prune case)"
  );

  const applied = await stashApplyIndexBySha(cwd, sha);
  assert.equal(applied.ok, true);
  git(cwd, ["commit", "--amend", "--no-edit"]);
  assert.equal(git(cwd, ["rev-parse", "HEAD:shared.txt"]), snapshotBlob, "the reverted content landed in HEAD");
  assert.equal(
    git(cwd, ["rev-list", "--objects", "HEAD", "--not", baseline, "--", "shared.txt"]).includes(snapshotBlob),
    false,
    "the retired new-content-only listing really does prune this blob"
  );

  const committed = await stagedSnapshotInHead(cwd, sha);
  assert.equal(committed.committed, true, committed.detail);
  const outcome = await reconcilePendingAppend(cwd, { changeStash: sha, targetHash: target, amended: true });
  assert.equal(outcome.kind, "resolved", "revert-to-earlier content is a completed append");
  assert.deepEqual(stashShaSet(cwd), [], "the entry this transaction owns is gone");
  assert.deepEqual(
    (outcome.stashRemoved ?? []).map((removal) => removal.status),
    ["removed"],
    "the removal is reported as one"
  );
});

test("a mode-only append that landed resolves on the tree mode and removes its own entry", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "shared.txt", "body\n", "base");
  const target = commitFile(cwd, "other.txt", "other\n", "target");

  // The "append" changes the executable bit and nothing else, so the snapshot's
  // blob id is byte-identical to the base's. A blob-id comparison cannot see the
  // difference; the tree comparison can.
  git(cwd, ["update-index", "--chmod=+x", "shared.txt"]);
  const sha = await stashPush(cwd);
  assert.ok(sha, "the snapshot was created");
  assert.equal(
    git(cwd, ["rev-parse", `${sha}^1:shared.txt`]),
    git(cwd, ["rev-parse", `${sha}^2:shared.txt`]),
    "the blob id is unchanged; only the mode differs"
  );

  const applied = await stashApplyIndexBySha(cwd, sha);
  assert.equal(applied.ok, true);
  git(cwd, ["commit", "--amend", "--no-edit"]);
  assert.match(git(cwd, ["ls-tree", "HEAD", "shared.txt"]), /^100755/, "the mode change landed in HEAD");

  const outcome = await reconcilePendingAppend(cwd, { changeStash: sha, targetHash: target, amended: true });
  assert.equal(outcome.kind, "resolved", "a landed mode change is confirmed by the tree entry");
  assert.deepEqual(stashShaSet(cwd), [], "the entry this transaction owns is gone");
});

test("a mode-only append whose chmod never landed keeps the record and the stash", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "shared.txt", "body\n", "base");
  const target = commitFile(cwd, "other.txt", "other\n", "target");

  // The P1 from Round 4: the blob id is identical before and after `chmod +x`,
  // so a blob-id predicate calls this "contained". Here the amend never happens,
  // so HEAD keeps mode 100644 and the `+x` exists only in the snapshot.
  git(cwd, ["update-index", "--chmod=+x", "shared.txt"]);
  const sha = await stashPush(cwd);
  assert.ok(sha, "the snapshot was created");
  assert.equal(
    git(cwd, ["rev-parse", `${sha}^1:shared.txt`]),
    git(cwd, ["rev-parse", `${sha}^2:shared.txt`]),
    "the blob id alone cannot distinguish the staged chmod"
  );

  // The append never happens: the target is rewritten *without* the snapshot, so
  // HEAD keeps mode 100644 and the `+x` survives only in the stash.
  fs.writeFileSync(path.join(cwd, "rewrite.txt"), "r\n", "utf8");
  git(cwd, ["add", "rewrite.txt"]);
  git(cwd, ["commit", "--amend", "--no-edit"]);
  assert.notEqual(git(cwd, ["rev-parse", "HEAD"]), target, "the recorded target was rewritten");
  assert.match(git(cwd, ["ls-tree", "HEAD", "shared.txt"]), /^100644/, "HEAD does not carry the chmod");

  const committed = await stagedSnapshotInHead(cwd, sha);
  assert.equal(committed.committed, false, "the mode difference is visible to the tree comparison");
  assert.match(committed.detail, /权限|shared\.txt/);

  const outcome = await reconcilePendingAppend(cwd, { changeStash: sha, targetHash: target, amended: true });
  assert.equal(outcome.kind, "pending", "an unlanded mode change must not be reported as contained");
  assert.equal(git(cwd, ["stash", "list"]).includes("stash@{0}"), true, "the stash is still the only copy");
});

test("a revert-shaped amend followed by a later edit keeps the record instead of warning forever", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  const original = Array.from({ length: 20 }, (_, i) => `LINE${i + 1}`);
  const write = (line2: string, line18 = "LINE18") => {
    const copy = [...original];
    copy[1] = line2;
    copy[17] = line18;
    fs.writeFileSync(path.join(cwd, "shared.txt"), copy.join("\n") + "\n", "utf8");
  };
  write("LINE2");
  git(cwd, ["add", "shared.txt"]);
  git(cwd, ["commit", "-qm", "base"]);
  const baseline = git(cwd, ["rev-parse", "HEAD"]);

  write("LINE2-APPEND");
  // A second file keeps the target commit non-empty once the append reverts the
  // shared file to its parent's exact content.
  fs.writeFileSync(path.join(cwd, "target.txt"), "target\n", "utf8");
  git(cwd, ["add", "shared.txt", "target.txt"]);
  git(cwd, ["commit", "-qm", "target"]);
  const target = git(cwd, ["rev-parse", "HEAD"]);

  // Revert to the *parent's exact* content and snapshot it, so the amend makes
  // the tree identical to its parent for this path and `git log --raw` emits no
  // entry at all -- the shape that defeated the retired history scan.
  write("LINE2");
  git(cwd, ["add", "shared.txt"]);
  const sha = await stashPush(cwd);
  assert.ok(sha, "the snapshot was created");
  assert.equal((await stashApplyIndexBySha(cwd, sha)).ok, true);
  git(cwd, ["commit", "--amend", "--no-edit"]);
  assert.equal(
    git(cwd, ["log", "--format=", "--raw", `${baseline}..HEAD`, "--", "shared.txt"]).trim(),
    "",
    "the revert-shaped amend emits no raw entry for this path"
  );

  // A later commit edits another line, so neither the raw scan nor the final
  // blob can identify the append any more.
  write("LINE2", "LINE18-LATER");
  git(cwd, ["add", "shared.txt"]);
  git(cwd, ["commit", "-qm", "later edit"]);

  const committed = await stagedSnapshotInHead(cwd, sha);
  assert.equal(committed.committed, false, committed.detail);
  const outcome = await reconcilePendingAppend(cwd, { changeStash: sha, targetHash: target, amended: true });
  assert.equal(outcome.kind, "pending", "an unprovable shape keeps the record; nothing is guessed");
  // Round 4's P1 was that the record then warned with no way out. The banner now
  // carries the commands, and the stash is still there for them to act on.
  assert.equal(git(cwd, ["stash", "list"]).includes("stash@{0}"), true, "the only copy is still present");
  const pending = outcome.kind === "pending" ? outcome : undefined;
  assert.ok(pending, "the outcome is a pending warning");
  const commands = recoveryCommands("stash@{0}", pending!.stashSha);
  assert.deepEqual(commands.map((step) => step.command), [
    "git stash apply --index stash@{0}",
    "git stash apply stash@{0}",
    "git stash drop stash@{0}",
  ]);
});

/**
 * Runs one printed command against a fresh repo holding the same stash.
 *
 * The steps are alternatives, not a sequence: applying twice would conflict on
 * the untracked file, so each must be evaluated on its own repository.
 */
async function runOneCommandPerRepo(command: string): Promise<void> {
  const cwd = createRepo();
  try {
    commitFile(cwd, "base.txt", "base\n", "base");
    const { sha } = await stashSnapshot(cwd);
    const name = await stashNameForSha(cwd, sha);
    const resolved = command.replace("${target}", name ?? sha);
    const res = await runGit(resolved.replace(/^git /, "").split(" "), { cwd });
    assert.equal(res.code, 0, `${resolved} must succeed: ${res.stderr}`);
  } finally {
    removeRepo(cwd);
  }
}

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

test("a coincidental same-bytes commit never authorises clearing the record", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "shared.txt", "original\n", "base");
  const target = commitFile(cwd, "target.txt", "target\n", "target");

  // The snapshot stages `appended\n` on shared.txt, but the append never runs.
  fs.writeFileSync(path.join(cwd, "shared.txt"), "appended\n", "utf8");
  git(cwd, ["add", "shared.txt"]);
  const sha = await stashPush(cwd);
  assert.ok(sha, "the snapshot was created");

  // An unrelated commit happens to write the same bytes to another file, and it
  // amends the target so the recorded SHA is rewritten. A `--find-object` style
  // predicate matches the blob; the tree comparison does not, because it looks
  // at *this* path and this path never received the append.
  fs.writeFileSync(path.join(cwd, "unrelated.txt"), "appended\n", "utf8");
  git(cwd, ["add", "unrelated.txt"]);
  git(cwd, ["commit", "--amend", "--no-edit"]);
  assert.notEqual(git(cwd, ["rev-parse", "HEAD"]), target, "the recorded target was rewritten");
  assert.equal(
    git(cwd, ["rev-parse", "HEAD:unrelated.txt"]),
    git(cwd, ["rev-parse", `${sha}^2:shared.txt`]),
    "the same blob id really does exist in HEAD, in another file"
  );
  assert.equal(git(cwd, ["show", "HEAD:shared.txt"]), "original", "shared.txt never received the append");

  const outcome = await reconcilePendingAppend(cwd, { changeStash: sha, targetHash: target, amended: true });
  assert.equal(outcome.kind, "pending", "same bytes elsewhere is not evidence the append landed");
  assert.equal(git(cwd, ["stash", "list"]).includes("stash@{0}"), true, "the only copy is preserved");
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
test("the first command offered for an index-present append exits 0 against the real state", async (t) => {
  const cwd = createRepo();
  t.after(() => cleanupRepo(cwd));
  git(cwd, ["config", "core.autocrlf", "false"]);
  const first = commitFile(cwd, "first.txt", "first\n", "first");
  const later = commitFile(cwd, "later.txt", "later\n", "later");

  // A staged new file; no worktree or untracked residue, so the only thing left
  // out of place is the staged half the guard reports.
  fs.writeFileSync(path.join(cwd, "append.txt"), "append\n", "utf8");
  git(cwd, ["add", "append.txt"]);
  const sha = await stashPush(cwd);
  assert.ok(sha);

  const stopped = await executeRebase(cwd, {
    onto: await resolveBase(cwd, first),
    items: [
      { hash: first, action: "edit", subject: "first" },
      { hash: later, action: "pick", subject: "later" },
    ],
  });
  assert.equal(stopped.stopped, true);
  const restored = await stashRestoreForAmend(cwd, sha!);
  assert.equal(restored.ok, true, restored.message);

  // The guard's shape: index present, amend never happened, rebase paused.
  const presence = await stashPresence(cwd, sha!);
  assert.equal(presence.index, "present", "the staged half is back in the index");
  // `index: "present"` alone also describes a snapshot with *no* staged half,
  // where `apply --index` succeeds; only a non-empty staged half already in the
  // index collides. Pin the count so the distinction the banner relies on is
  // part of the test and not an accident of this fixture.
  assert.equal(presence.indexPaths, 1, "the snapshot's staged half is non-empty");
  const outcome = await reconcilePendingAppend(cwd, { changeStash: sha!, targetHash: first, amended: false });
  assert.equal(outcome.kind, "pending", "the append is still incomplete");

  const name = await stashNameForSha(cwd, sha!);
  const steps = recoveryCommands(name, sha!, presence);
  assert.ok(steps.length > 0, "the banner offers a command");
  assert.equal(
    steps[0].command.startsWith("git stash apply --index"),
    false,
    `an index-present snapshot must not lead with --index, got: ${JSON.stringify(steps.map((s) => s.command))}`
  );

  // Execute what is actually printed, against this state.
  const args = steps[0].command.replace(/^git /, "").split(" ");
  const result = await runGit(args, { cwd });
  assert.equal(result.code, 0, `the first offered command must succeed: ${steps[0].command}\n${result.stderr}`);
});

/**
 * `presence.complete` is a *content* question. It cannot see an index that
 * `git stash apply --index` failed to write, so a non-zero exit has to be its
 * own failure signal.
 *
 * Shape: the append was stopped at the target with a snapshot that stages a new
 * file and edits an existing one. The rebase then continued past a later commit
 * that deletes the edited path, which leaves `apply --index` with a
 * modify/delete conflict: it writes the worktree side (so every content probe
 * afterwards reports `present`, `complete: true`) but exits 1 with
 * "Index was not unstashed", leaving `DU later.txt` in the index. Reading only
 * `complete` turned that into `restored`, cleared the record, and left the user
 * with a rebase that cannot continue and no banner explaining why.
 */
test("a failed apply --index keeps the record even when post-apply content probes look complete", async (t) => {
  const cwd = createRepo();
  t.after(() => cleanupRepo(cwd));
  git(cwd, ["config", "core.autocrlf", "false"]);
  const first = commitFile(cwd, "first.txt", "first\n", "first");
  const target = commitFile(cwd, "later.txt", "v1\n", "target");

  // Snapshot: stage a new file, and leave an unstaged edit of later.txt so the
  // stash carries a worktree side for the same path.
  fs.writeFileSync(path.join(cwd, "append.txt"), "append\n", "utf8");
  git(cwd, ["add", "append.txt"]);
  fs.writeFileSync(path.join(cwd, "later.txt"), "v2\n", "utf8");
  const sha = await stashPush(cwd);
  assert.ok(sha, "the snapshot stash was created");

  // Delete later.txt in a commit the rebase replays, so the snapshot's worktree
  // side collides with a delete.
  git(cwd, ["rm", "-q", "later.txt"]);
  git(cwd, ["commit", "-qm", "delete later.txt"]);

  const before = await stashPresence(cwd, sha!);
  assert.equal(before.complete, false, "the snapshot is not restored before recovery runs");

  const outcome = await reconcilePendingAppend(cwd, { changeStash: sha!, targetHash: target, amended: false });
  assert.equal(
    outcome.kind,
    "pending",
    `a non-zero apply must keep the record, got: ${JSON.stringify(outcome)}`
  );
  assert.equal(outcome.kind === "pending" ? outcome.stashSha : undefined, sha, "the record still names its stash");
  assert.match(
    outcome.kind === "pending" ? outcome.reason : "",
    /not unstashed|未在|失败/i,
    "the reason carries the command's own message"
  );
  assert.equal(git(cwd, ["stash", "list"]).includes("stash@{0}"), true, "the recovery copy is never dropped");

  // The decisive evidence: after the failed apply the *content* probe reports a
  // complete snapshot. Reading `complete` alone therefore cannot distinguish
  // this state from success — only the exit code can, and the index is still
  // unmerged, so `git rebase --continue` would fail here.
  const after = await stashPresence(cwd, sha!);
  assert.equal(after.complete, true, "the content probes cannot see the failed index write");
  assert.ok(git(cwd, ["ls-files", "-u"]).includes("later.txt"), "the index really is left unmerged");
  assert.equal(fs.existsSync(path.join(cwd, "append.txt")), true, "the staged half did reach the worktree");
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
