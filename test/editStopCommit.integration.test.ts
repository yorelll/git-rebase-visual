import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import test from "node:test";
import { fullMessage, isRebaseInProgress } from "../src/git/commitLog";
import { abortRebase, executeRebase, resolveBase } from "../src/git/rebaseEngine";
import { writeEditStopCommit } from "../src/ui/editStopCommit";
import { commitFile, createRepo, git, gitEnv, gitExit, removeRepo } from "./helpers/gitTestRepo";

async function startEditStop(cwd: string): Promise<{ target: string; tip: string }> {
  const base = commitFile(cwd, "base.txt", "base\n", "base");
  const target = commitFile(cwd, "target.txt", "target\n", "feat: target\n\nChange-Id: I123\nSigned-off-by: Test <test@example.com>");
  const tip = commitFile(cwd, "tip.txt", "tip\n", "tip");
  const outcome = await executeRebase(cwd, {
    onto: await resolveBase(cwd, base),
    items: [
      { hash: base, action: "pick", subject: "base" },
      { hash: target, action: "edit", subject: "feat: target" },
      { hash: tip, action: "pick", subject: "tip" },
    ],
  });
  assert.equal(outcome.stopped, true);
  return { target, tip };
}

test("edit-stop amend keeps original trailers through the real Git write", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  await startEditStop(cwd);
  fs.writeFileSync(path.join(cwd, "target.txt"), "amended\n", "utf8");
  git(cwd, ["add", "target.txt"]);

  await writeEditStopCommit(cwd, "amend", "feat: amended\n\nCorrect target");
  assert.equal(
    await fullMessage(cwd, "HEAD"),
    "feat: amended\n\nCorrect target\n\nChange-Id: I123\nSigned-off-by: Test <test@example.com>"
  );
  assert.equal(await isRebaseInProgress(cwd), true);
  await abortRebase(cwd);
});

test("edit-stop new commit does not inherit the stopped commit trailer block", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  await startEditStop(cwd);
  fs.writeFileSync(path.join(cwd, "new.txt"), "new\n", "utf8");
  git(cwd, ["add", "new.txt"]);

  await writeEditStopCommit(cwd, "new", "feat: follow-up\n\nSeparate change");
  const message = await fullMessage(cwd, "HEAD");
  assert.equal(message, "feat: follow-up\n\nSeparate change");
  assert.equal(message.includes("Change-Id: I123"), false);
  assert.equal(await isRebaseInProgress(cwd), true);
  await abortRebase(cwd);
});

test("edit-stop writer refuses an empty staged index before creating a commit", async (t) => {
  const cwd = createRepo();
  t.after(async () => {
    await abortRebase(cwd);
    removeRepo(cwd);
  });
  await startEditStop(cwd);
  await assert.rejects(() => writeEditStopCommit(cwd, "amend", "feat: should not write"), /暂存区为空/);
});

test("a real edit stop remains writable when the next todo command is another edit", async (t) => {
  const cwd = createRepo();
  t.after(async () => {
    await abortRebase(cwd);
    removeRepo(cwd);
  });
  const base = commitFile(cwd, "base.txt", "base\n", "base");
  const first = commitFile(cwd, "first.txt", "first\n", "first\n\nChange-Id: I111");
  const second = commitFile(cwd, "second.txt", "second\n", "second");
  const outcome = await executeRebase(cwd, {
    onto: await resolveBase(cwd, base),
    items: [
      { hash: base, action: "pick", subject: "base" },
      { hash: first, action: "edit", subject: "first" },
      { hash: second, action: "edit", subject: "second" },
    ],
  });
  assert.equal(outcome.stopped, true);
  fs.writeFileSync(path.join(cwd, "first.txt"), "amended\n", "utf8");
  git(cwd, ["add", "first.txt"]);

  await writeEditStopCommit(cwd, "amend", "first: amended");
  assert.equal(await fullMessage(cwd, "HEAD"), "first: amended\n\nChange-Id: I111");
});

/**
 * The new contract: `abortRebase` never deletes a file.
 *
 * An earlier implementation tried to clear the blockage automatically whenever
 * it could "prove" the deletion lossless. That proof was wrong three rounds
 * running (ownership, then attribute source, then relative `core.attributesFile`
 * and worktree-dependent smudge filters), because the class — every way a
 * checkout filter can depend on more than the blob — is not enumerable. One
 * wrong prediction destroys bytes that exist in no commit and no stash.
 *
 * So the abort now refuses and explains. The user moves the file; nothing is
 * lost by stopping. This test pins the whole contract: the throw, the paths in
 * the message, the explicit "nothing was deleted" assurance, byte-identical
 * files, an intact stash, and a rebase that is still paused so the user can act.
 */
test("abort refuses an untracked collision, deletes nothing and keeps the rebase paused", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  git(cwd, ["config", "core.autocrlf", "false"]);
  const base = commitFile(cwd, "base.txt", "base\n", "base");
  const target = commitFile(cwd, "target.txt", "target\n", "target");
  const tip = commitFile(cwd, "later.txt", "later\n", "later");

  const outcome = await executeRebase(cwd, {
    onto: await resolveBase(cwd, base),
    items: [
      { hash: base, action: "pick", subject: "base" },
      { hash: target, action: "edit", subject: "target" },
      { hash: tip, action: "pick", subject: "later" },
    ],
  });
  assert.equal(outcome.stopped, true);

  // The collision the append transaction leaves: the later commit's path in the
  // worktree while the paused commit predates it, so it is untracked.
  const collisionBytes = Buffer.from("later\n", "utf8");
  fs.writeFileSync(path.join(cwd, "later.txt"), collisionBytes);
  // A file no commit ever owned. It must survive for a completely different
  // reason: it is not even mentioned by Git, so nothing may touch it either.
  const userBytes = Buffer.from("MY IRREPLACEABLE NOTES\n", "utf8");
  fs.writeFileSync(path.join(cwd, "mine.txt"), userBytes);

  assert.notEqual(gitExit(cwd, ["rebase", "--abort"]), 0, "a plain abort is blocked by the untracked file");
  const stashBefore = git(cwd, ["stash", "list"]);

  let error: string | undefined;
  try {
    await abortRebase(cwd);
  } catch (e: any) {
    error = String(e?.message ?? e);
  }

  assert.ok(error, "the abort refuses instead of deleting");
  assert.match(error!, /later\.txt/, "the message names the blocked path");
  assert.match(error!, /没有删除任何文件/, "and states plainly that nothing was deleted");
  assert.match(error!, /移到|重命名|mv /, "and gives a concrete next step");
  // No stash exists in this repo, so the message must not claim one does.
  assert.match(error!, /git stash list/, "and refers to the stash by the command that shows it");
  assert.match(error!, /为空/, "and admits the list is empty instead of claiming a copy the user cannot find");

  assert.deepEqual(
    fs.readFileSync(path.join(cwd, "later.txt")),
    collisionBytes,
    "the collision path's bytes are untouched, even though they equal the committed blob"
  );
  assert.deepEqual(fs.readFileSync(path.join(cwd, "mine.txt")), userBytes, "the unrelated user file is untouched");
  assert.equal(git(cwd, ["stash", "list"]), stashBefore, "the stash is intact");
  assert.equal(await isRebaseInProgress(cwd), true, "the rebase is still paused so the user can act");
  assert.notEqual(git(cwd, ["rev-parse", "HEAD"]), tip, "history has not moved");
});

/**
 * The stash sentence must match `git stash list`, in both directions.
 *
 * A safety message that says "your changes are still in the stash" when the
 * stash is empty is falsified by the first command a worried user runs, and that
 * costs the rest of the message its credibility. So the message is generated
 * from the actual list, and this test pins both branches: empty when it is
 * empty, a real count when there really are entries.
 */
test("the abort refusal describes the stash as it actually is, not as assumed", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  git(cwd, ["config", "core.autocrlf", "false"]);
  await pausedRebaseWithLater(cwd);
  fs.writeFileSync(path.join(cwd, "later.txt"), "later\n", "utf8");

  // Branch 1: nothing in the stash.
  assert.equal(git(cwd, ["stash", "list"]), "", "the stash starts empty");
  const emptyError = await refusalMessage(cwd);
  assert.match(emptyError, /git stash list/, "the message points at the command that shows the truth");
  assert.match(emptyError, /为空/, "and says the list is empty rather than claiming a copy that is not there");
  assert.doesNotMatch(emptyError, /仍在 stash 中|仍完整保存在 stash/, "and never makes the old unconditional claim");

  // Branch 2: a real stash entry. A tracked file is modified and stashed (no
  // `-u`), so `later.txt` stays untracked and still blocks the abort.
  fs.writeFileSync(path.join(cwd, "target.txt"), "STASHED WORK\n", "utf8");
  git(cwd, ["stash", "push", "--", "target.txt"]);
  assert.match(git(cwd, ["stash", "list"]), /stash@\{0\}/, "the stash now holds one entry");
  const withStash = await refusalMessage(cwd);
  assert.match(withStash, /1 条记录/, "the message reports the count it measured");
  assert.match(withStash, /都还在列表里/, "and does not claim anything about what those entries contain");
});

/**
 * The documented recovery path, end to end: move the file aside, run Abort
 * again, and it succeeds. If this test passes while the refusal test passes,
 * the message really describes something that works.
 */
test("a second abort succeeds after the user moves the collision file aside", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  git(cwd, ["config", "core.autocrlf", "false"]);
  const { tip } = await pausedRebaseWithLater(cwd);

  const collisionBytes = Buffer.from("later\n", "utf8");
  fs.writeFileSync(path.join(cwd, "later.txt"), collisionBytes);
  assert.notEqual(gitExit(cwd, ["rebase", "--abort"]), 0, "a plain abort is blocked");
  await assert.rejects(() => abortRebase(cwd), /没有删除任何文件/, "the first abort refuses");

  // Do exactly what the message tells the user to do. `rename` is the portable
  // form of the suggested `mv <path> <path>.bak`.
  fs.renameSync(path.join(cwd, "later.txt"), path.join(cwd, "later.txt.bak"));
  assert.deepEqual(fs.readFileSync(path.join(cwd, "later.txt.bak")), collisionBytes, "the moved copy still holds the bytes");

  await abortRebase(cwd);

  assert.equal(await isRebaseInProgress(cwd), false, "the abort completed");
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), tip, "history is back to the pre-rebase tip");
  assert.deepEqual(
    fs.readFileSync(path.join(cwd, "later.txt.bak")),
    collisionBytes,
    "the file the user moved is still exactly what they moved"
  );
  assert.equal(
    fs.readFileSync(path.join(cwd, "later.txt"), "utf8").replace(/\r\n/g, "\n"),
    "later\n",
    "the reset restored the path from the commit"
  );
});

/**
 * N-2 kept as a cheap permanent regression test.
 *
 * This was the shape that defeated byte comparison: a clean form equal to the
 * blob while the checkout form is not. Now that the answer is always "refuse",
 * it costs one assertion and pins the contract regardless of which prediction
 * strategy a future change might try.
 */
test("abort refuses a CRLF file whose normalization equals the committed blob (eol=lf)", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  fs.writeFileSync(path.join(cwd, ".gitattributes"), "*.txt text eol=lf\n", "utf8");
  git(cwd, ["config", "core.autocrlf", "false"]);
  const { tip } = await pausedRebaseWithLater(cwd);

  const userBytes = Buffer.from("later\r\n", "utf8");
  fs.writeFileSync(path.join(cwd, "later.txt"), userBytes);
  assert.equal(
    git(cwd, ["hash-object", "--path=later.txt", "--", "later.txt"]).trim(),
    git(cwd, ["rev-parse", `${tip}:later.txt`]).trim(),
    "the clean form really equals the blob, so a hashes-match rule would delete here"
  );
  assert.notEqual(gitExit(cwd, ["rebase", "--abort"]), 0, "a plain abort is blocked");

  await assert.rejects(() => abortRebase(cwd), /没有删除任何文件/, "refused");
  assert.deepEqual(fs.readFileSync(path.join(cwd, "later.txt")), userBytes, "the CRLF bytes are untouched");
  assert.equal(await isRebaseInProgress(cwd), true, "the rebase is still paused");

  fs.rmSync(path.join(cwd, "later.txt"), { force: true });
  assert.equal(gitExit(cwd, ["rebase", "--abort"]), 0);
});

/**
 * N5-1: a *relative* `core.attributesFile`.
 *
 * Git resolves that path against the process's working directory. The removed
 * predictor ran its synthetic checkout with `GIT_WORK_TREE` pointing at a
 * scratch directory, so the attribute file was not found and the prediction
 * described a checkout the real reset would never perform. This is the shape
 * that made the prediction approach untenable: it is not a bug in one
 * comparison but a structural consequence of running Git somewhere other than
 * the real worktree. Pinned now as a plain refusal.
 */
test("abort refuses when a relative core.attributesFile changes the checkout form", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  git(cwd, ["config", "core.autocrlf", "false"]);
  // `cfg/global.attrs` is resolved relative to Git's working directory, which is
  // the repository root for both the abort and this test.
  fs.mkdirSync(path.join(cwd, "cfg"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "cfg", "global.attrs"), "*.txt eol=crlf\n", "utf8");
  git(cwd, ["config", "core.attributesFile", "cfg/global.attrs"]);
  const { tip } = await pausedRebaseWithLater(cwd);

  // Premise: the attribute really applies, and the blob really is LF.
  assert.match(
    git(cwd, ["check-attr", "eol", "--", "later.txt"]),
    /eol: crlf/,
    "the relative attributes file is in effect"
  );
  assert.equal(git(cwd, ["cat-file", "blob", `${tip}:later.txt`]), "later", "the stored blob is LF");

  // The premise that made the old predictor unsound: run Git with
  // `GIT_WORK_TREE` pointed at a scratch directory — exactly what the synthetic
  // checkout did — and the *same* attribute file is no longer found, so the
  // predicted checkout form changes. That divergence, not any particular
  // comparison, is why the prediction approach was abandoned.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "grv-n51-"));
  try {
    assert.match(
      gitEnv(cwd, ["check-attr", "eol", "--", "later.txt"], { GIT_WORK_TREE: scratch }),
      /eol: unspecified/,
      "with GIT_WORK_TREE elsewhere the relative attributes file is not found"
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const userBytes = Buffer.from("later\r\n", "utf8");
  fs.writeFileSync(path.join(cwd, "later.txt"), userBytes);
  assert.notEqual(gitExit(cwd, ["rebase", "--abort"]), 0, "a plain abort is blocked");

  await assert.rejects(() => abortRebase(cwd), /没有删除任何文件/, "refused");
  assert.deepEqual(fs.readFileSync(path.join(cwd, "later.txt")), userBytes, "the user's bytes survive");
  assert.equal(await isRebaseInProgress(cwd), true, "the rebase is still paused");
});

/**
 * N5-2: a smudge filter whose output depends on the *worktree*, not just the
 * blob. A synthetic checkout cannot reproduce it, so any prediction built on one
 * is unsound here too. Pinned as a refusal.
 */
test("abort refuses when a smudge filter reads worktree state", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  git(cwd, ["config", "core.autocrlf", "false"]);
  // The smudge filter emits the contents of a worktree file, so the same blob
  // checks out differently depending on what else is on disk right now.
  git(cwd, ["config", "filter.stamp.smudge", "cat stamp.txt 2>/dev/null || echo none"]);
  git(cwd, ["config", "filter.stamp.clean", "cat"]);
  fs.writeFileSync(path.join(cwd, ".gitattributes"), "*.txt filter=stamp\n", "utf8");
  fs.writeFileSync(path.join(cwd, "stamp.txt"), "STAMP\n", "utf8");
  const { tip } = await pausedRebaseWithLater(cwd);

  assert.match(git(cwd, ["check-attr", "filter", "--", "later.txt"]), /filter: stamp/, "the filter is in effect");
  assert.equal(git(cwd, ["cat-file", "blob", `${tip}:later.txt`]), "later", "the stored blob is the raw text");
  // The premise this test actually rests on: the checkout form differs from the
  // blob, so a prediction built by comparing the two would be wrong here. Pinning
  // it matters — swapping the filter for identity `cat` leaves every other
  // assertion in this test green (the refusal still happens), so without this line
  // the test would keep passing after losing the very property it documents.
  assert.equal(
    git(cwd, ["cat-file", "--filters", `${tip}:later.txt`]),
    "STAMP",
    "the filter changes the checkout form, so it differs from the blob"
  );
  assert.notEqual(
    git(cwd, ["cat-file", "--filters", `${tip}:later.txt`]),
    git(cwd, ["cat-file", "blob", `${tip}:later.txt`]),
    "checkout form differs from the blob — the premise that defeated the predictor"
  );

  const userBytes = Buffer.from("WORKTREE-DEPENDENT OUTPUT\n", "utf8");
  fs.writeFileSync(path.join(cwd, "later.txt"), userBytes);
  assert.notEqual(gitExit(cwd, ["rebase", "--abort"]), 0, "a plain abort is blocked");

  await assert.rejects(() => abortRebase(cwd), /没有删除任何文件/, "refused");
  assert.deepEqual(fs.readFileSync(path.join(cwd, "later.txt")), userBytes, "the user's bytes survive");
  assert.equal(await isRebaseInProgress(cwd), true, "the rebase is still paused");
});

/**
 * Regression guard: when nothing blocks the abort, it must simply succeed. An
 * "always refuse" implementation would pass every test above and break the
 * normal case, so this pins the other side.
 */
test("abort succeeds normally when the tree is clean", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  git(cwd, ["config", "core.autocrlf", "false"]);
  const { tip } = await pausedRebaseWithLater(cwd);

  await abortRebase(cwd);

  assert.equal(await isRebaseInProgress(cwd), false, "the abort completed");
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), tip, "history is back to the pre-rebase tip");
});


/** Runs an abort that must refuse, and returns the message it threw. */
async function refusalMessage(cwd: string): Promise<string> {
  try {
    await abortRebase(cwd);
  } catch (e: any) {
    return String(e?.message ?? e);
  }
  throw new Error("abortRebase did not refuse");
}

/**
 * Pauses a rebase at an `edit` stop with a later commit that owns `later.txt`.
 *
 * Kept because several refusal tests need exactly this shape: the paused commit
 * predates `later.txt`, so writing that path into the worktree makes it
 * untracked and `git rebase --abort` refuses.
 */
async function pausedRebaseWithLater(cwd: string): Promise<{ target: string; tip: string }> {
  const base = commitFile(cwd, "base.txt", "base\n", "base");
  const target = commitFile(cwd, "target.txt", "target\n", "target");
  const tip = commitFile(cwd, "later.txt", "later\n", "later");
  const outcome = await executeRebase(cwd, {
    onto: await resolveBase(cwd, base),
    items: [
      { hash: base, action: "pick", subject: "base" },
      { hash: target, action: "edit", subject: "target" },
      { hash: tip, action: "pick", subject: "later" },
    ],
  });
  assert.equal(outcome.stopped, true);
  return { target, tip };
}

/**
 * N-3: a *directory* collision uses different Git wording from a file collision.
 * Recognizing it separately means the error can name the directory and give
 * advice that fits a directory, rather than showing raw Git output.
 */
test("abort refuses a directory collision and keeps the directory's contents", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  git(cwd, ["config", "core.autocrlf", "false"]);
  const { tip } = await pausedRebaseWithLater(cwd);

  // Replace the collision path with a directory holding an untracked file.
  fs.rmSync(path.join(cwd, "later.txt"), { force: true });
  fs.mkdirSync(path.join(cwd, "later.txt"));
  fs.writeFileSync(path.join(cwd, "later.txt", "keep.txt"), "KEEP THIS\n", "utf8");
  assert.notEqual(gitExit(cwd, ["rebase", "--abort"]), 0, "a plain abort is blocked by the directory");

  let error: string | undefined;
  try {
    await abortRebase(cwd);
  } catch (e: any) {
    error = String(e?.message ?? e);
  }

  assert.ok(error, "a directory collision is refused rather than passed through");
  assert.match(error!, /later\.txt/, "the refusal names the directory");
  assert.match(error!, /没有删除任何文件/, "and says plainly that nothing was deleted");
  assert.equal(fs.statSync(path.join(cwd, "later.txt")).isDirectory(), true, "the directory is still there");
  assert.equal(
    fs.readFileSync(path.join(cwd, "later.txt", "keep.txt"), "utf8"),
    "KEEP THIS\n",
    "its contents are untouched"
  );
  assert.equal(await isRebaseInProgress(cwd), true, "the rebase is still paused so the user can act");

  fs.rmSync(path.join(cwd, "later.txt"), { recursive: true, force: true });
  assert.equal(gitExit(cwd, ["rebase", "--abort"]), 0);
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), tip);
});

/**
 * N-3, general principle: an abort failure this code does not understand must
 * never reach a deletion. A corrupted `orig-head` is a real, easily produced
 * shape with unrecognizable output — the recovery must surface it and keep
 * every file on disk.
 */
test("an unrecognized abort failure deletes nothing", async (t) => {
  const cwd = createRepo();
  t.after(() => removeRepo(cwd));
  git(cwd, ["config", "core.autocrlf", "false"]);
  await pausedRebaseWithLater(cwd);

  // One file at a collision path and one no commit owns. Neither may be removed.
  fs.writeFileSync(path.join(cwd, "later.txt"), "USER BYTES\n", "utf8");
  fs.writeFileSync(path.join(cwd, "mine.txt"), "ALSO MINE\n", "utf8");

  // Corrupt the recorded pre-rebase HEAD so the abort fails for a reason no
  // collision parser recognizes.
  const origHead = path.join(cwd, ".git", "rebase-merge", "orig-head");
  assert.equal(fs.existsSync(origHead), true, "the rebase recorded its original head");
  fs.writeFileSync(origHead, "0000000000000000000000000000000000000000\n", "utf8");

  let error: string | undefined;
  try {
    await abortRebase(cwd);
  } catch (e: any) {
    error = String(e?.message ?? e);
  }

  assert.ok(error, "an unrecognized failure is surfaced, not swallowed");
  assert.equal(
    fs.readFileSync(path.join(cwd, "later.txt"), "utf8"),
    "USER BYTES\n",
    "the collision-path file survives an unrecognized failure"
  );
  assert.equal(
    fs.readFileSync(path.join(cwd, "mine.txt"), "utf8"),
    "ALSO MINE\n",
    "an unrelated user file survives"
  );
});
