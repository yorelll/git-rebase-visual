import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as path from "path";
import {
  resolveBase,
  executeRebase,
} from "../src/git/rebaseEngine";
import { isRebaseInProgress } from "../src/git/commitLog";
import {
  reconcilePendingAppend,
  recoveryCommands,
  stagedSnapshotInHead,
  stashNameForSha,
  stashPresence,
} from "../src/git/pendingRecovery";
import { runGit } from "../src/git/gitRunner";
import {
  stashApplyIndexBySha,
  stashPush,
  stashRestoreForAmend,
} from "../src/git/worktree";
import {
  cleanupRepo,
  commitFile,
  createRepo,
  git,
} from "./helpers/gitTestRepo";
import {
  cleanup,
  pushUserStash,
  stashShaSet,
  stashSnapshot,
} from "./helpers/pendingRecoveryFixtures";

/**
 * The append transaction: whether an amend actually landed, and what the record does when it cannot be proved either way.
 *
 * Split out of `pendingRecovery.integration.test.ts` (no test was added, removed,
 * or rewritten). These run under Node's per-file scheduling, so each one owns its
 * repositories and shares nothing at module level.
 */

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
