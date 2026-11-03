import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as path from "path";


import {
  reconcilePendingAppend,
  reconcilePendingStash,
  resetDecision,
  stashNameForSha,
  stashPresence,
} from "../src/git/pendingRecovery";

import {
  stashApplyIndexBySha,
  stashPush,
} from "../src/git/worktree";
import {
  commitFile,
  createRepo,
  git,
} from "./helpers/gitTestRepo";
import {
  cleanup,
  deleteLooseObject,
  pushUserStash,
  stashShaSet,
  stashSnapshot,
} from "./helpers/pendingRecoveryFixtures";

/**
 * Settling a pending autostash record: when its content counts as verified, when the entry is removed, and what the user is told.
 *
 * Split out of `pendingRecovery.integration.test.ts` (no test was added, removed,
 * or rewritten). These run under Node's per-file scheduling, so each one owns its
 * repositories and shares nothing at module level.
 */

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
