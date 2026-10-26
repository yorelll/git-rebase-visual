import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as path from "path";
import { resolveBase, executeRebase } from "../src/git/rebaseEngine";
import {
  reconcilePendingAppend,
  reconcilePendingStash,
  recoveryCommands,
  resetDecision,
  stagedSnapshotInHead,
  stashNameForSha,
  stashPresence,
} from "../src/git/pendingRecovery";
import { GitInvocationLog, runGit, setGitInvocationObserver } from "../src/git/gitRunner";
import { stashApplyIndexBySha, stashPush, stashPushKeepIndex } from "../src/git/worktree";
import { commitFile, createRepo, git, removeRepo } from "./helpers/gitTestRepo";

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

test("an already-applied snapshot resolves without warning and keeps the stash", async (t) => {
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
  // The record settles, but the recovery copy is never deleted automatically.
  assert.equal(outcome.kind === "resolved" ? outcome.stashKept?.sha : undefined, sha, "the kept stash is reported");
  assert.equal(git(cwd, ["stash", "list"]).includes("stash@{0}"), true, "the stash is still listed");
});

test("manual git stash apply --index followed by reconciliation clears silently and keeps the stash", async (t) => {
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
  assert.equal(git(cwd, ["stash", "list"]).includes("stash@{0}"), true, "the stash is left for the user to clean up");
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

test("a fresh snapshot is restored once and its stash is left in place", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);
  assert.ok((await stashPresence(cwd, sha)).listed);

  const outcome = await reconcilePendingStash(cwd, sha);
  assert.equal(outcome.kind, "restored");
  assert.equal(outcome.kind === "restored" ? outcome.stashKept?.sha : undefined, sha, "the kept stash is reported");
  assert.equal(git(cwd, ["stash", "list"]).includes("stash@{0}"), true, "the recovery copy survives the restore");
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
  assert.equal(git(cwd, ["stash", "list"]).includes("stash@{0}"), true, "the snapshot stash is kept");
});

test("an append whose amend landed resolves on a confirmed tree match and keeps the stash", async (t) => {
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
  assert.equal(git(cwd, ["stash", "list"]).includes("stash@{0}"), true, "the snapshot stash is never deleted");
  assert.equal(outcome.kind === "resolved" ? outcome.stashKept?.sha : undefined, sha, "the kept copy is reported");
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

test("a settled recovery reports the stash it kept, never one it removed", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);
  const outcome = await reconcilePendingStash(cwd, sha);
  assert.equal(outcome.kind, "restored");
  assert.equal("dropped" in outcome, false, "the outcome type has no way to report a deletion");
  if (outcome.kind === "restored") {
    assert.ok(outcome.stashKept, "a verified restore reports the copy it left behind");
    assert.match(outcome.stashKept!.name ?? "", /^stash@\{\d+\}$/);
    assert.equal(outcome.stashKept!.sha, sha);
  }
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

test("a settled record names its own slot and leaves other stashes untouched", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  commitFile(cwd, "base.txt", "base\n", "base");
  const { sha } = await stashSnapshot(cwd);
  assert.ok(sha, "first stash exists");
  // Push an unrelated stash above it; the slot for our sha shifts to @{1}.
  fs.writeFileSync(path.join(cwd, "other.txt"), "other\n", "utf8");
  git(cwd, ["stash", "push", "-u", "-q"]);
  const other = git(cwd, ["rev-parse", "stash@{0}"]);
  assert.notEqual(other, sha);
  const name = await stashNameForSha(cwd, sha);
  assert.equal(name, "stash@{1}", "the sha resolves to its current slot, not a stale index");

  git(cwd, ["stash", "apply", "--index", name as string]);
  assert.equal((await stashPresence(cwd, sha)).complete, true, "every part was verified");

  const outcome = await reconcilePendingStash(cwd, sha);
  assert.equal(outcome.kind, "resolved");
  assert.equal(outcome.kind === "resolved" ? outcome.stashKept?.sha : undefined, sha, "the kept slot names our own sha");
  assert.equal(outcome.kind === "resolved" ? outcome.stashKept?.name : undefined, "stash@{1}");
  const remaining = git(cwd, ["stash", "list", "--format=%H"]).split("\n").map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(remaining, [other, sha], "both stashes survive; the extension removed nothing");
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
  assert.equal(outcome.kind === "resolved" ? outcome.stashKept : "none", undefined, "no kept copy is claimed either");
});

/**
 * The shapes below are the Round-4 findings, now handled by design rather than
 * by a better containment predicate: the extension no longer decides to delete
 * anything, so an ambiguous shape simply keeps its record, its banner and its
 * stash. Each test asserts the *record* outcome and, crucially, that the stash
 * survives in every one of them.
 */

test("a completed append whose content matches HEAD resolves and keeps the stash", async (t) => {
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
  assert.equal(git(cwd, ["stash", "list"]).includes("stash@{0}"), true, "the stash is kept");
});

test("a mode-only append that landed resolves on the tree mode, not the blob id", async (t) => {
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
  assert.equal(git(cwd, ["stash", "list"]).includes("stash@{0}"), true, "the stash is kept");
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

test("a full recovery pass invokes no stash-removing Git command", async (t) => {
  const cwd = createRepo();
  cleanup(t, cwd);
  const first = commitFile(cwd, "first.txt", "first\n", "first");
  commitFile(cwd, "keep.txt", "keep\n", "keep");
  const target = commitFile(cwd, "target.txt", "target\n", "target");

  // Both halves of an append, so the pass exercises the branches that used to
  // call `stash drop`: the worktree (keep-index) stash and the change stash.
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

  const destructive = observed.filter(
    (entry) =>
      entry.args[0] === "stash" &&
      (entry.args[1] === "drop" || entry.args[1] === "pop" || entry.args[1] === "clear")
  );
  assert.deepEqual(
    destructive.map((entry) => entry.args.join(" ")),
    [],
    "no recovery path may drop, pop or clear a stash"
  );
  // Both recovery copies are still listed, and the worktree-only content is back.
  const remaining = git(cwd, ["stash", "list", "--format=%H"]).split("\n").map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(remaining.sort(), [changeStash, unstagedStash].sort(), "both stashes survive the pass");
  assert.equal(
    fs.readFileSync(path.join(cwd, "keep.txt"), "utf8").replace(/\r\n/g, "\n"),
    "keep WORKTREE\n",
    "the worktree-only content was restored"
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
